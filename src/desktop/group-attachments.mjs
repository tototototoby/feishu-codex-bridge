import { mkdir, copyFile, stat, readFile, realpath, lstat, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, basename, extname, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import crossSpawn from 'cross-spawn';
import { FIXED_GROUP_ID, FIXED_OWNER_OPEN_ID } from './group-recorder.mjs';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL = 75 * 1024 * 1024;
function assertInside(root, path) {
  const part = relative(root, path);
  if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('attachment-path-outside-workspace');
}
async function ownedDirectory(root, directory) {
  try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const actual = await realpath(directory); assertInside(root, actual);
  if (!(await stat(actual)).isDirectory()) throw new Error('attachment-directory-invalid');
  return actual;
}
async function ownedTarget(root, target) {
  assertInside(root, await realpath(dirname(target)));
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('attachment-target-invalid');
    assertInside(root, await realpath(target));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function download(cliPath, directory, messageId, key, type, targetName) {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(cliPath, ['im', '+messages-resources-download', '--message-id', messageId,
      '--file-key', key, '--type', type, '--output', targetName, '--as', 'user', '--format', 'json'],
    { cwd: directory, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let completed = false;
    const timer = setTimeout(() => { child.kill(); }, 30000);
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); if (output.length > 1024 * 1024) child.kill(); });
    child.stderr.resume();
    child.on('error', () => { completed = true; clearTimeout(timer); reject(new Error('attachment-download-failed')); });
    child.on('close', (code) => {
      clearTimeout(timer); if (completed) return;
      try { if (code !== 0 || JSON.parse(output).ok !== true) throw new Error(); resolve(); }
      catch { reject(new Error('attachment-download-failed')); }
    });
  });
}

export async function prepareGroupAttachments({ control, msg, context, directAttachments = [], cliPath }) {
  if (control?.groupId !== FIXED_GROUP_ID || context?.groupId !== FIXED_GROUP_ID || msg?.chatId !== FIXED_GROUP_ID || msg.senderId !== FIXED_OWNER_OPEN_ID) throw new Error('attachment-scope-mismatch');
  const root = await realpath(control.groupWorkspace);
  const input = await ownedDirectory(root, join(root, 'input'));
  const directory = await ownedDirectory(root, join(input, 'feishu-attachments'));
  const accepted = []; const seen = new Set(); let total = 0;
  for (const attachment of directAttachments.slice(0, 10)) {
    try {
    if (attachment.decision !== 'accepted' || !attachment.absPath) continue;
    const size = (await stat(attachment.absPath)).size;
    if (size > MAX_BYTES || total + size > MAX_TOTAL) continue;
    const extension = extname(attachment.originalName || attachment.absPath).slice(0, 12);
    const name = `${createHash('sha256').update(attachment.absPath).digest('hex').slice(0, 24)}${extension}`;
    const target = join(directory, name);
    await ownedTarget(root, target);
    try { await copyFile(attachment.absPath, target, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await ownedTarget(root, target);
    accepted.push({ ...attachment, absPath: await realpath(target) }); total += size;
    } catch { /* One unavailable direct attachment does not discard the others. */ }
  }
  const directAcceptedCount = accepted.length; let historyMissingCount = 0;
  const requestTime = Number(msg.createTime) || Date.now();
  const linked = msg.replyToMessageId || msg.rootId;
  const wantsFile = /附件|文件|压缩|裁图|原图|大小|尺寸|调整|处理/.test(msg.content || '');
  const records = [...(context.messages || [])].reverse().filter((record) =>
    !record.deleted && ['file', 'image'].includes(record.msgType) &&
    (record.messageId === linked || wantsFile && Math.abs(Date.parse(record.timestamp) - requestTime) <= 120000)).slice(0, 3);
  for (const record of records) {
    if (accepted.length >= 10) break;
    for (const key of (record.attachmentRefs || []).slice(0, 1)) {
      if (seen.has(key)) continue; seen.add(key);
      const image = record.msgType === 'image';
      const originalName = record.content?.match(/name="([^"]+)"/)?.[1] || (image ? '群图片.jpg' : '群附件.zip');
      const extension = image ? '.jpg' : extname(originalName).toLowerCase();
      if (!image && !['.zip', '.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.csv'].includes(extension)) continue;
      const targetName = `${createHash('sha256').update(record.messageId).update(key).digest('hex').slice(0, 24)}${extension}`;
      const target = join(directory, targetName);
      let downloaded = false;
      try {
        await ownedTarget(root, target);
        try { await stat(target); } catch { await download(cliPath, directory, record.messageId, key, image ? 'image' : 'file', targetName); downloaded = true; }
        await ownedTarget(root, target);
        const size = (await stat(target)).size;
        if (size > MAX_BYTES || total + size > MAX_TOTAL) {
          if (downloaded) await rm(target);
          historyMissingCount++; continue;
        }
        const bytes = await readFile(target);
        const imageMime = bytes[0] === 137 && bytes[1] === 80 ? 'image/png' : bytes.toString('ascii', 0, 4) === 'RIFF' ? 'image/webp' : 'image/jpeg';
        accepted.push({ decision: 'accepted', absPath: await realpath(target), originalName: basename(originalName), kind: image ? 'image' : 'file',
          mime: image ? imageMime : extension === '.zip' ? 'application/zip' : 'application/octet-stream', size,
          hash: createHash('sha256').update(bytes).digest('hex'), sourceMessageId: record.messageId });
        total += size;
      } catch { historyMissingCount++; }
    }
  }
  Object.defineProperties(accepted, { directAcceptedCount: { value: directAcceptedCount }, historyMissingCount: { value: historyMissingCount } });
  return accepted;
}
