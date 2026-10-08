import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import { loadProjectConfig } from '../settings.mjs';

const CODEX_VERSION_DIRECTORY = /^[0-9a-f]{16}$/i;
const DESKTOP_BINARY_ERROR = 'Desktop Codex binary is missing or ambiguous. Repair the installation or the executable path in the Desktop profile.';
const CONFIGURATION_ERROR = 'Desktop Codex recovery requires a readable project configuration. Repair the configuration before restarting the Desktop adapter.';

/** Resolve only a missing default Codex Desktop binary from the local versioned install. */
export function resolveDesktopCodexBinary(binaryPath) {
  if (process.platform !== 'win32' || typeof binaryPath !== 'string' || !binaryPath) return binaryPath;

  if (win32.isAbsolute(binaryPath)) {
    if (!isMissingPath(binaryPath)) return binaryPath;
    if (!isVersionedDesktopBinary(binaryPath)) return binaryPath;
    const config = readRequiredProjectConfig();
    if (hasExplicitCodexPath(config)) return binaryPath;
    return findUniqueDesktopBinary();
  }

  if (!isBareCodexCommand(binaryPath) || isAvailableOnPath(binaryPath)) return binaryPath;
  const config = readRequiredProjectConfig();
  if (hasExplicitCodexPath(config)) return binaryPath;
  return findUniqueDesktopBinary();
}

function isRegularFile(path) {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function isMissingPath(path) {
  try { lstatSync(path); return false; }
  catch (error) { return error?.code === 'ENOENT'; }
}

function isVersionedDesktopBinary(binaryPath) {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !win32.isAbsolute(localAppData)) return false;
  const binRoot = win32.resolve(localAppData, 'OpenAI', 'Codex', 'bin');
  const relativePath = win32.relative(binRoot, win32.resolve(binaryPath));
  const parts = relativePath.split(win32.sep);
  return parts.length === 2 && CODEX_VERSION_DIRECTORY.test(parts[0]) && parts[1].toLowerCase() === 'codex.exe';
}

function isBareCodexCommand(binaryPath) {
  return /^codex(?:\.exe)?$/i.test(binaryPath);
}

function isAvailableOnPath(binaryPath) {
  const pathExtensions = binaryPath.toLowerCase().endsWith('.exe')
    ? ['']
    : [...new Set(['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')])];
  const pathValue = process.env.PATH;
  if (!pathValue) return false;
  const pathEntries = pathValue.split(win32.delimiter);
  for (const rawEntry of pathEntries) {
    const unquoted = rawEntry.trim().replace(/^"|"$/g, '');
    const directory = unquoted || process.cwd();
    for (const extension of pathExtensions) {
      const candidate = win32.join(directory, `${binaryPath}${extension}`);
      if (isRegularFile(candidate)) return true;
    }
  }
  return false;
}

function readRequiredProjectConfig() {
  try { return loadProjectConfig({ required: true }); }
  catch { throw new Error(CONFIGURATION_ERROR); }
}

function hasExplicitCodexPath(config) {
  return Boolean(config.tools && typeof config.tools === 'object' && Object.hasOwn(config.tools, 'codex'));
}

function findUniqueDesktopBinary() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !win32.isAbsolute(localAppData)) throw new Error(DESKTOP_BINARY_ERROR);
  const binRoot = win32.resolve(localAppData, 'OpenAI', 'Codex', 'bin');
  let rootRealPath;
  let entries;
  try {
    rootRealPath = realpathSync(binRoot);
    entries = readdirSync(binRoot, { withFileTypes: true });
  } catch { throw new Error(DESKTOP_BINARY_ERROR); }

  const candidates = [];
  for (const entry of entries) {
    if (!CODEX_VERSION_DIRECTORY.test(entry.name)) continue;
    const versionDirectory = win32.join(binRoot, entry.name);
    const candidate = win32.join(versionDirectory, 'codex.exe');
    try {
      const directoryInfo = lstatSync(versionDirectory);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) continue;
      const fileInfo = lstatSync(candidate);
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) continue;
      const candidateRealPath = realpathSync(candidate);
      if (!isContainedPath(rootRealPath, candidateRealPath)) continue;
      candidates.push(candidateRealPath);
    } catch { /* Ignore incomplete or inaccessible version directories. */ }
  }

  if (candidates.length !== 1) throw new Error(DESKTOP_BINARY_ERROR);
  return candidates[0];
}

function isContainedPath(rootPath, candidatePath) {
  const relativePath = win32.relative(rootPath, candidatePath);
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relativePath);
}
