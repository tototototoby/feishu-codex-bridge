import { mkdir, copyFile, stat, readFile, realpath, lstat, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, basename, extname, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import crossSpawn from 'cross-spawn';
import { isVerifiedSupplementalGroupBinding, supplementalGroupMessageDisposition } from './supplemental-group-binding.mjs';
import { FIXED_GROUP_ID, FIXED_OWNER_OPEN_ID } from './group-recorder.mjs';
import { isMemberImageContext, memberImageFormat, stageMemberImageInputs, verifyMemberImageReference, verifyMemberImageSource } from './group-member-images.mjs';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL = 75 * 1024 * 1024;
function attachmentTime(value) {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? time < 100_000_000_000 ? time * 1000 : time : NaN;
}
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

export async function prepareGroupAttachments({ binding = null, control, msg, context, directAttachments = [], allowedAttachmentMessageIds = [], cliPath, imageTask, botOwnerId, channel }) {
  if (binding !== null) {
    if (!isVerifiedSupplementalGroupBinding(binding) || imageTask || control !== binding.control || context?.binding !== binding ||
        control.groupId !== binding.groupId || control.ownerOpenId !== binding.ownerOpenId || control.botAppId !== binding.appId ||
        context.groupId !== binding.groupId || context.appId !== binding.appId || context.desktopThreadId !== binding.threadId ||
        msg?.chatId !== binding.groupId || botOwnerId !== binding.ownerOpenId || channel?.opts?.appId !== binding.appId ||
        !['owner-task', 'trusted-member-task'].includes(supplementalGroupMessageDisposition(msg, botOwnerId, binding))) throw new Error('attachment-binding-mismatch');
    const originals = await channel.fetchRawMessage(msg.messageId);
    if (!originals.some((original) => original.message_id === msg.messageId && original.chat_id === binding.groupId &&
        !original.deleted && (original.sender?.id ?? original.sender_id) === msg.senderId &&
        (original.sender?.sender_type ?? original.sender?.type ?? original.sender_type) === 'user')) throw new Error('attachment-request-source-mismatch');
  }
  if (imageTask) return prepareMemberImageAttachments({ control, msg, context, directAttachments, cliPath, imageTask });
  if (!binding && (control?.groupId !== FIXED_GROUP_ID || context?.groupId !== FIXED_GROUP_ID || msg?.chatId !== FIXED_GROUP_ID || msg.senderId !== FIXED_OWNER_OPEN_ID)) throw new Error('attachment-scope-mismatch');
  const root = await realpath(control.groupWorkspace);
  if (binding && relative(binding.groupWorkspace, root)) throw new Error('attachment-workspace-binding-mismatch');
  const input = await ownedDirectory(root, join(root, 'input'));
  const directory = await ownedDirectory(root, join(input, 'feishu-attachments'));
  const accepted = []; const seen = new Set(); let total = 0;
  for (const attachment of directAttachments.slice(0, 10)) {
    try {
    if (attachment.decision !== 'accepted' || !attachment.absPath || attachment.sourceMessageId !== msg.messageId) continue;
    if (binding && (attachment.sourceMessageId !== msg.messageId ||
        attachment.groupId !== undefined && attachment.groupId !== binding.groupId ||
        attachment.appId !== undefined && attachment.appId !== binding.appId)) continue;
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
  // The selector admits only this source and platform-verified explicit quotes.
  // No keyword or proximity fallback may import another actor's or future files.
  const allowed = new Set(allowedAttachmentMessageIds);
  allowed.add(msg.messageId);
  const records = [...(context.messages || [])].reverse().filter((record) =>
    !record.deleted && ['file', 'image'].includes(record.msgType) && allowed.has(record.messageId)).slice(0, 3);
  for (const record of records) {
    if (accepted.length >= 10) break;
    if (channel) {
      try {
        if (channel?.opts?.appId !== (binding?.appId ?? control.botAppId)) throw new Error('attachment-app-mismatch');
        const originals = await channel.fetchRawMessage(record.messageId);
        if (!originals.some((original) => original.message_id === record.messageId && original.chat_id === (binding?.groupId ?? control.groupId) && !original.deleted &&
          attachmentTime(original.create_time ?? original.createTime) <= attachmentTime(msg.createTime))) throw new Error('attachment-original-mismatch');
      } catch { historyMissingCount++; continue; }
    }
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

async function prepareMemberImageAttachments({ control, msg, context, directAttachments, cliPath, imageTask }) {
  if (!isMemberImageContext(imageTask) || control?.memberImagesEnabled !== true || control.groupId !== FIXED_GROUP_ID ||
    msg?.chatId !== FIXED_GROUP_ID || context?.groupId !== FIXED_GROUP_ID || context !== imageTask.groupContext ||
    imageTask.sourceMessageId !== msg.messageId || imageTask.senderId !== msg.senderId) throw new Error('member-attachment-scope-mismatch');
  await verifyMemberImageSource(imageTask);
  const direct = await stageMemberImageInputs(imageTask, directAttachments.filter((attachment) => attachment.sourceMessageId === msg.messageId));
  const candidates = [];
  const linked = msg.replyToMessageId || msg.rootId;
  const wantsImage = imageTask.expectsImage || Boolean(linked);
  let requestTime = Number(msg.createTime);
  if (requestTime > 0 && requestTime < 100_000_000_000) requestTime *= 1000;
  if (!Number.isFinite(requestTime) || requestTime <= 0) requestTime = Date.now();
  const records = [...(context.messages || [])].reverse().filter((record) => !record.deleted && record.msgType === 'image' &&
    (record.messageId === linked || wantsImage && Date.parse(record.timestamp) <= requestTime));
  records.sort((left, right) => Number(right.messageId === linked) - Number(left.messageId === linked));
  let missing = 0;
  const seen = new Set();
  for (const record of records.slice(0, 3)) {
    for (const key of (record.attachmentRefs || []).slice(0, 1)) {
      if (seen.has(key) || !/^img_[A-Za-z0-9_-]+$/.test(key)) continue;
      seen.add(key);
      try {
        await verifyMemberImageReference(imageTask, record, key);
        const name = `${createHash('sha256').update(record.messageId).update(key).digest('hex')}.jpg`;
        const target = join(imageTask.inputDirectory, name);
        await ownedTarget(imageTask.workspace, target);
        await download(cliPath, imageTask.inputDirectory, record.messageId, key, 'image', name);
        await ownedTarget(imageTask.workspace, target);
        const size = (await stat(target)).size;
        if (size < 4 || size > MAX_BYTES) throw new Error('member-attachment-size-invalid');
        const bytes = await readFile(target);
        const format = memberImageFormat(bytes);
        candidates.push({ decision: 'accepted', absPath: target, originalName: `群参考图${format.extension}`,
          kind: 'image', mime: format.mime, size, sourceMessageId: record.messageId });
      } catch { missing++; }
    }
  }
  const history = await stageMemberImageInputs(imageTask, candidates);
  const accepted = [...new Map([...direct, ...history].map((attachment) => [attachment.hash, attachment])).values()];
  Object.defineProperties(accepted, { directAcceptedCount: { value: direct.length },
    historyMissingCount: { value: missing + candidates.length - history.length } });
  return accepted;
}
