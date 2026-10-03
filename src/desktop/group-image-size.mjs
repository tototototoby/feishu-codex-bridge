import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { loadProjectConfig } from '../settings.mjs';

const require = createRequire(import.meta.url);
let sharpModule;

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_PIXELS = 128_000_000;
const DOWNSCALE_FACTOR = 0.82;
const MAX_DOWNSCALE_RETRIES = 5;

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name}-must-be-a-positive-integer`);
  return value;
}

async function getOutputDirectory(workspace) {
  if (typeof workspace !== 'string' || !workspace.trim()) throw new TypeError('workspace-required');
  const workspaceRoot = await realpath(resolve(workspace));
  const outputDirectory = join(workspaceRoot, 'output');
  const bridgeDirectory = join(outputDirectory, 'bridge-images');
  await ensureWorkspaceDirectory(outputDirectory);
  await ensureWorkspaceDirectory(bridgeDirectory);
  const localPath = relative(workspaceRoot, bridgeDirectory);
  if (!localPath || localPath.startsWith('..') || isAbsolute(localPath)) throw new Error('image-output-path-escapes-workspace');
  return bridgeDirectory;
}

async function ensureWorkspaceDirectory(directory) {
  try {
    if (await realpath(directory) !== directory) throw new Error('image-output-path-escapes-workspace');
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try { await mkdir(directory); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (await realpath(directory) !== directory) throw new Error('image-output-path-escapes-workspace');
}

async function writeAtomically(targetPath, data) {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    try {
      const info = await lstat(targetPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('image-output-target-invalid');
      const existing = await readFile(targetPath);
      if (existing.equals(data)) return;
      throw new Error('image-output-hash-collision');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await writeFile(temporaryPath, data, { flag: 'wx' });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    // A concurrent invocation may have installed the same content after the
    // initial existence check. Accept that only after reading it back.
    if (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES') {
      try {
        const info = await lstat(targetPath);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('image-output-target-invalid');
        const existing = await readFile(targetPath);
        if (existing.equals(data)) return;
      } catch { /* Preserve the original write/rename error. */ }
    }
    throw error;
  }
}

/**
 * Prepare an image for group delivery, preserving the input bytes and saving
 * any derivative beneath workspace/output/bridge-images.
 */
export async function prepareGroupImage({
  bytes,
  sourcePath,
  workspace,
  maxBytes = 9 * 1024 * 1024,
  maxDimension = 4096,
  maxPixels = 8_000_000,
} = {}) {
  positiveInteger(maxBytes, 'maxBytes');
  positiveInteger(maxDimension, 'maxDimension');
  positiveInteger(maxPixels, 'maxPixels');
  if (!(bytes instanceof Uint8Array)) throw new TypeError('image-bytes-required');
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_INPUT_BYTES) throw new Error('image-input-size-invalid');

  // Copy the view so callers cannot mutate the data while metadata and output
  // are being calculated.
  const original = Buffer.from(bytes);
  const sharp = getSharp();
  const metadata = await sharp(original, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new Error('image-dimensions-invalid');
  }
  if (width * height > MAX_INPUT_PIXELS) throw new Error('image-pixel-limit-exceeded');
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('image-format-unsupported');
  if ((metadata.pages ?? 1) > 1) throw new Error('animated-image-unsupported');

  const originalBytes = original.byteLength;
  const pixels = width * height;
  if (originalBytes <= maxBytes && Math.max(width, height) <= maxDimension && pixels <= maxPixels) {
    return { bytes: original, targetPath: sourcePath ?? null, transformed: false, width, height, originalBytes };
  }

  const preserveAlpha = metadata.hasAlpha === true;
  const outputFormat = preserveAlpha ? 'png' : 'jpeg';
  const extension = preserveAlpha ? '.png' : '.jpg';
  const initialScale = Math.min(
    1,
    maxDimension / width,
    maxDimension / height,
    Math.sqrt(maxPixels / pixels),
  );

  let scale = initialScale;
  let output = null;
  let outputInfo = null;
  for (let attempt = 0; attempt <= MAX_DOWNSCALE_RETRIES; attempt += 1) {
    const targetWidth = Math.max(1, Math.floor(width * scale));
    const targetHeight = Math.max(1, Math.floor(height * scale));
    let pipeline = sharp(original, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: targetWidth, height: targetHeight, fit: 'inside', withoutEnlargement: true });
    pipeline = preserveAlpha
      ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
      : pipeline.jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true });

    const encoded = await pipeline.toBuffer({ resolveWithObject: true });
    output = encoded.data;
    outputInfo = encoded.info;
    if (output.byteLength <= maxBytes) break;
    output = null;
    outputInfo = null;
    if (attempt === MAX_DOWNSCALE_RETRIES) break;
    scale *= DOWNSCALE_FACTOR;
  }

  if (!output || output.byteLength > maxBytes) throw new Error('image-cannot-fit-size-limit');
  if (!Number.isSafeInteger(outputInfo?.width) || !Number.isSafeInteger(outputInfo?.height)) {
    throw new Error('image-output-dimensions-invalid');
  }

  const directory = await getOutputDirectory(workspace);
  const digest = createHash('sha256').update(output).digest('hex');
  const targetPath = join(directory, `group-${digest}${extension}`);
  const localPath = relative(directory, resolve(targetPath));
  if (!localPath || localPath.startsWith('..') || isAbsolute(localPath)) throw new Error('image-output-path-invalid');
  await writeAtomically(targetPath, output);

  return {
    bytes: output,
    targetPath,
    transformed: true,
    width: outputInfo.width,
    height: outputInfo.height,
    originalBytes,
  };
}

function getSharp() {
  if (sharpModule) return sharpModule;
  try {
    const configuredPath = loadProjectConfig().tools?.sharp;
    if (configuredPath != null && (typeof configuredPath !== 'string' || !configuredPath.trim())) {
      throw new Error('invalid-sharp-path');
    }
    const loaded = configuredPath
      ? require(isAbsolute(configuredPath) ? resolve(configuredPath) : configuredPath)
      : require('sharp');
    sharpModule = loaded.default ?? loaded;
    if (typeof sharpModule !== 'function') throw new Error('invalid-sharp-module');
    return sharpModule;
  } catch {
    throw new Error('Image resizing requires sharp installed with this project or tools.sharp set to its absolute module path.');
  }
}
