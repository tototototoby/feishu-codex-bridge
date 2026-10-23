import { mkdir, realpath, lstat, open, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FIXED_GROUP_ID } from './group-recorder.mjs';
import { groupScopeReplyOptions, isAllowedMemberImageRequest } from './group-policy.mjs';

const contexts = new WeakSet();
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_COUNT = 8;
const MAX_TOTAL_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 75 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NATIVE_IMAGE_NAME = /^exec-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)$/i;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalized = (path) => resolve(path).toLowerCase();
function inside(root, path) {
  const part = relative(root, path);
  return Boolean(part) && part !== '..' && !part.startsWith(`..\\`) && !part.startsWith('../') && !isAbsolute(part);
}
function assertContext(context) {
  if (!context || !contexts.has(context)) throw new Error('member-image-context-untrusted');
}
export function isMemberImageContext(context) { return Boolean(context && contexts.has(context)); }
export function memberImageFormat(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: '.png', mime: 'image/png' };
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { extension: '.jpg', mime: 'image/jpeg' };
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { extension: '.webp', mime: 'image/webp' };
  throw new Error('member-image-format-invalid');
}
async function noLinks(root, target, directory = false) {
  if (normalized(root) !== normalized(target) && !inside(root, target)) throw new Error('member-image-path-outside-root');
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('member-image-directory-invalid');
  const parts = relative(root, target).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 || directory ? !info.isDirectory() : !info.isFile())) {
      throw new Error('member-image-path-invalid');
    }
  }
  if (normalized(await realpath(target)) !== normalized(target)) throw new Error('member-image-realpath-mismatch');
}
async function makeDirectory(root, directory) {
  if (!inside(root, directory)) throw new Error('member-image-directory-outside-workspace');
  await mkdir(directory, { recursive: true });
  await noLinks(root, directory, true);
  return directory;
}
async function readImage(path, maximum, { root, startedAt } = {}) {
  const absolute = resolve(path);
  if (root) await noLinks(root, absolute);
  else if ((await lstat(absolute)).isSymbolicLink()) throw new Error('member-image-input-symlink');
  const actual = await realpath(absolute);
  const handle = await open(actual, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 4 || before.size > maximum) throw new Error('member-image-size-invalid');
    if (startedAt && (before.birthtimeMs < startedAt - 2000 || before.mtimeMs < startedAt - 2000)) throw new Error('member-image-not-created-this-run');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new Error('member-image-changed-during-read');
    if (root) await noLinks(root, absolute);
    return { bytes, hash: hash(bytes), ...memberImageFormat(bytes) };
  } finally { await handle.close(); }
}
function isDeleted(message) {
  return message?.deleted === true || message?.deleted === 'true' || message?.is_deleted === true || message?.is_deleted === 'true';
}
function sourceIdentity(message) {
  return { id: message?.sender?.id ?? message?.sender?.open_id ?? message?.sender_id,
    type: message?.sender?.sender_type ?? message?.sender?.type ?? message?.sender_type };
}
async function fetchGroupMessage(channel, messageId) {
  if (typeof messageId !== 'string' || !/^om_[A-Za-z0-9_-]+$/.test(messageId)) throw new Error('member-image-source-id-invalid');
  const rows = await channel.fetchRawMessage(messageId);
  const message = rows.find((row) => row.message_id === messageId);
  if (!message || message.chat_id !== FIXED_GROUP_ID || isDeleted(message)) throw new Error('member-image-source-not-verified');
  return message;
}
export async function verifyMemberImageSource(context) {
  assertContext(context);
  const message = await fetchGroupMessage(context.channel, context.sourceMessageId);
  const sender = sourceIdentity(message);
  if (sender.type !== 'user' || sender.id !== context.senderId) throw new Error('member-image-source-sender-mismatch');
  // The normalized mention is host supplied, and the native readback must still
  // contain the actual application's mention; quoted @ text grants nothing.
  const mentions = message.mentions ?? [];
  if (!mentions.some((mention) => (mention.id ?? mention.open_id) === context.botAppId ||
    Boolean(context.botOpenId && (mention.id === context.botOpenId || mention.open_id === context.botOpenId)))) throw new Error('member-image-source-mention-missing');
  return message;
}
async function manifest(context) {
  await noLinks(context.workspace, context.outputDirectory, true);
  const path = join(context.outputDirectory, 'manifest.json');
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('member-image-manifest-invalid'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(path, JSON.stringify({ version: 1, requestId: context.requestId, groupId: FIXED_GROUP_ID,
    sourceMessageId: context.sourceMessageId, senderId: context.senderId, startedAt: context.startedAt,
    nativeThreadId: context.nativeThreadId ?? null, nativeThreadConflict: context.nativeThreadConflict === true,
    inputs: context.inputs, artifacts: context.artifacts, rejectedArtifactCount: context.rejectedArtifactCount }, null, 2), 'utf8');
}
export async function createMemberImageContext({ control, msg, botOwnerId, channel, groupContext }) {
  if (!isAllowedMemberImageRequest(msg, botOwnerId, control) || groupContext?.groupId !== FIXED_GROUP_ID ||
    typeof channel?.fetchRawMessage !== 'function') throw new Error('member-image-request-not-authorized');
  const workspace = await realpath(control.groupWorkspace);
  const requestId = randomUUID();
  const context = { requestId, workspace, channel, sourceMessageId: msg.messageId, senderId: msg.senderId,
    botAppId: control.botAppId, botOpenId: channel.botIdentity?.openId,
    replyInThread: groupScopeReplyOptions(msg, control).replyInThread === true, inputs: [], artifacts: [], rejectedArtifactCount: 0,
    startedAt: 0, nativeRoots: [], seenItems: new Set(),
    expectsImage: /图|海报|画|logo|image|绘|设计|改一下|修改|再改|调整|美化|生成/i.test(msg.content || ''),
    groupContext };
  contexts.add(context);
  await verifyMemberImageSource(context);
  context.inputDirectory = await makeDirectory(workspace, join(workspace, 'input', requestId));
  context.outputDirectory = await makeDirectory(workspace, join(workspace, 'output', requestId));
  await manifest(context);
  return context;
}
// History is only considered from the fixed group's host recorder, then each
// source is independently read back before its attachment is downloaded.
export async function verifyMemberImageReference(context, record, key) {
  assertContext(context);
  if (context.groupContext.groupId !== FIXED_GROUP_ID || !context.groupContext.messages.some((message) => message === record) ||
    record.deleted || record.msgType !== 'image' || !record.attachmentRefs?.includes(key)) throw new Error('member-image-reference-context-invalid');
  const source = await fetchGroupMessage(context.channel, record.messageId);
  if (source.msg_type !== 'image' || !JSON.stringify(source.body ?? source.content ?? '').includes(key)) throw new Error('member-image-reference-key-mismatch');
  return source;
}
export async function stageMemberImageInputs(context, attachments) {
  assertContext(context);
  let total = context.inputs.reduce((sum, input) => sum + input.size, 0);
  const accepted = [];
  for (const attachment of attachments.slice(0, 10)) {
    if (attachment.decision !== 'accepted' || attachment.kind !== 'image' || !attachment.absPath) continue;
    try {
      const sourceId = attachment.sourceMessageId;
      if (sourceId !== context.sourceMessageId && !context.groupContext.messages.some((message) => message.messageId === sourceId && !message.deleted && message.msgType === 'image')) continue;
      await fetchGroupMessage(context.channel, sourceId);
      const image = await readImage(attachment.absPath, MAX_INPUT_BYTES);
      if (total + image.bytes.length > MAX_TOTAL_INPUT_BYTES) continue;
      const path = join(context.inputDirectory, `${image.hash}${image.extension}`);
      await noLinks(context.workspace, context.inputDirectory, true);
      try { await writeFile(path, image.bytes, { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const staged = await readImage(path, MAX_INPUT_BYTES, { root: context.workspace });
      if (staged.hash !== image.hash) throw new Error('member-image-staged-hash-mismatch');
      if (!context.inputs.some((input) => input.hash === image.hash)) {
        context.inputs.push({ path, hash: image.hash, size: image.bytes.length, sourceMessageId: sourceId,
          provenance: attachment.provenance === 'local-brand' ? 'local-brand' : 'group-image' });
        total += image.bytes.length;
      }
      accepted.push({ ...attachment, absPath: path, hash: image.hash, size: image.bytes.length, mime: image.mime, kind: 'image' });
    } catch { /* An invalid reference must not expand the run's input set. */ }
  }
  if (accepted.length) context.expectsImage = true;
  await manifest(context);
  return accepted;
}
export function configureMemberImageRun(context, { cwd, codexHome }) {
  assertContext(context);
  if (normalized(cwd) !== normalized(context.workspace) || !codexHome || context.startedAt) throw new Error('member-image-run-scope-invalid');
  context.startedAt = Date.now();
  context.nativeCacheRoot = resolve(codexHome, 'generated_images');
  context.nativeRoots = [context.workspace, context.nativeCacheRoot];
}
function remainingOutputBytes(context) {
  if (context.artifacts.length >= MAX_OUTPUT_COUNT) return 0;
  return Math.max(0, MAX_TOTAL_OUTPUT_BYTES - context.artifacts.reduce((sum, artifact) => sum + artifact.size, 0));
}
async function registerNativeImage(context, sourcePath, root, { nativeItemId = null, provenance }) {
  // Completion events and thread-directory fallback share one request budget:
  // at most 8 artifacts / 128 MiB total, checked before reading another file.
  const remaining = remainingOutputBytes(context);
  if (!remaining) return;
  const image = await readImage(sourcePath, Math.min(MAX_OUTPUT_BYTES, remaining), { root, startedAt: context.startedAt });
  if (context.inputs.some((input) => input.hash === image.hash)) throw new Error('member-image-artifact-is-input');
  if (context.artifacts.some((artifact) => artifact.hash === image.hash)) return;
  await noLinks(context.workspace, context.outputDirectory, true);
  const path = join(context.outputDirectory, `${image.hash}${image.extension}`);
  await writeFile(path, image.bytes, { flag: 'wx' });
  const copied = await readImage(path, MAX_OUTPUT_BYTES, { root: context.workspace, startedAt: context.startedAt });
  if (copied.hash !== image.hash) throw new Error('member-image-artifact-hash-mismatch');
  context.artifacts.push({ path, hash: image.hash, size: image.bytes.length, mime: image.mime,
    nativeItemId, provenance, capturedAt: Date.now() });
}
export async function captureMemberImageEvent(context, event) {
  assertContext(context);
  if (!context.startedAt) return;
  if (event?.type === 'thread.started') {
    const threadId = event.thread_id;
    if (typeof threadId !== 'string' || !UUID.test(threadId) || !context.nativeCacheRoot) return;
    if (context.nativeThreadId && context.nativeThreadId !== threadId) {
      context.nativeThreadConflict = true;
    } else if (!context.nativeThreadId) {
      context.nativeThreadId = threadId;
      context.nativeThreadRoot = join(context.nativeCacheRoot, threadId);
    }
    await manifest(context);
    return;
  }
  const item = event.item;
  if (!item || !['image_generation', 'imageGeneration'].includes(item.type)) return;
  context.imageAttempted = true;
  if (!['item.completed', 'item_completed', 'itemCompleted'].includes(event?.type)) return;
  if (item.status && !['completed', 'complete', 'success', 'succeeded'].includes(item.status)) return;
  const savedPath = item.saved_path ?? item.savedPath;
  if (typeof savedPath !== 'string' || !savedPath || savedPath.includes('\0')) {
    context.rejectedArtifactCount++;
    await manifest(context);
    return;
  }
  const eventId = `${item.id ?? ''}:${savedPath}`;
  if (context.seenItems.has(eventId)) return;
  context.seenItems.add(eventId);
  try {
    const sourcePath = resolve(context.workspace, savedPath);
    const root = context.nativeRoots.find((candidate) => inside(candidate, sourcePath));
    if (!root) throw new Error('member-image-artifact-outside-native-roots');
    await registerNativeImage(context, sourcePath, root, { nativeItemId: typeof item.id === 'string' ? item.id : null,
      provenance: 'native-completed-item' });
  } catch { context.rejectedArtifactCount++; }
  await manifest(context);
}
// Some CLI releases omit native image items from exec --json. Bind only the
// fresh ephemeral run's structured thread.started UUID, never a final-text path
// or a search across generated_images for a recent file.
export async function finalizeMemberImages(context, { terminal, interrupted } = {}) {
  assertContext(context);
  if (terminal !== 'done' || interrupted || !context.startedAt || !context.nativeThreadRoot || context.nativeThreadConflict) return registeredMemberImages(context);
  const expected = join(context.nativeCacheRoot, context.nativeThreadId);
  if (!UUID.test(context.nativeThreadId) || normalized(expected) !== normalized(context.nativeThreadRoot)) throw new Error('member-image-native-thread-invalid');
  try {
    await noLinks(context.nativeCacheRoot, context.nativeThreadRoot, true);
    const files = await readdir(context.nativeThreadRoot, { withFileTypes: true });
    for (const file of files.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && NATIVE_IMAGE_NAME.test(entry.name)).slice(0, 64)) {
      if (!remainingOutputBytes(context)) break;
      try {
        await registerNativeImage(context, join(context.nativeThreadRoot, file.name), context.nativeCacheRoot,
          { provenance: 'native-thread-directory' });
      } catch { context.rejectedArtifactCount++; }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') context.rejectedArtifactCount++;
  }
  await manifest(context);
  return registeredMemberImages(context);
}
export function registeredMemberImages(context) {
  assertContext(context);
  return context.artifacts.map((artifact) => ({ ...artifact }));
}
export async function enqueueMemberImages({ context, channel, groupMedia }) {
  assertContext(context);
  if (channel !== context.channel || typeof groupMedia?.enqueueFromAnswer !== 'function') throw new Error('member-image-return-channel-invalid');
  await verifyMemberImageSource(context);
  const artifacts = registeredMemberImages(context);
  for (const artifact of artifacts) {
    if (!inside(context.outputDirectory, artifact.path)) throw new Error('member-image-return-path-invalid');
    const image = await readImage(artifact.path, MAX_OUTPUT_BYTES, { root: context.workspace, startedAt: context.startedAt });
    if (image.hash !== artifact.hash) throw new Error('member-image-return-hash-mismatch');
  }
  const answer = artifacts.map((artifact) => `[本次图片成品](<${artifact.path}>)`).join('\n');
  if (artifacts.length) await groupMedia.enqueueFromAnswer({ messageId: context.sourceMessageId, replyInThread: context.replyInThread }, answer);
  return artifacts;
}
