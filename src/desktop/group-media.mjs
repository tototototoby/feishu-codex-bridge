import { readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, basename, dirname } from 'node:path';
import { FIXED_GROUP_ID } from './group-recorder.mjs';
import { isVerifiedSupplementalGroupBinding, supplementalGroupMessageDisposition } from './supplemental-group-binding.mjs';
import { prepareGroupImage } from './group-image-size.mjs';

export class GroupMedia {
  #binding = null;
  #groupId = FIXED_GROUP_ID;
  constructor({ binding = null, channel, workspace, statePath, logger = () => {} }) {
    if (binding !== null) {
      if (!isVerifiedSupplementalGroupBinding(binding)) throw new Error('unverified-media-binding');
      if (workspace !== undefined && resolve(workspace) !== resolve(binding.groupWorkspace) ||
          statePath !== undefined && resolve(statePath) !== resolve(binding.paths.mediaStatePath)) throw new Error('media-binding-path-mismatch');
      this.#binding = binding; this.#groupId = binding.groupId;
      workspace = binding.groupWorkspace; statePath = binding.paths.mediaStatePath;
      if (channel?.opts?.appId !== binding.appId) throw new Error('media-binding-app-mismatch');
    }
    this.channel = channel; this.workspace = workspace; this.statePath = statePath; this.logger = logger;
    this.jobs = []; this.tail = Promise.resolve(); this.timer = null; this.closed = false;
  }
  assertBindingScope() {
    if (this.#binding && (this.channel?.opts?.appId !== this.#binding.appId ||
        resolve(this.workspace) !== resolve(this.#binding.groupWorkspace) ||
        resolve(this.statePath) !== resolve(this.#binding.paths.mediaStatePath))) throw new Error('media-binding-scope-mismatch');
  }
  validRequest(request) {
    if (!this.#binding) return true;
    const binding = this.#binding;
    if (request?.chatId !== binding.groupId || request.appId !== binding.appId || request.desktopThreadId !== binding.threadId ||
        typeof request.requestId !== 'string' || !request.requestId || typeof request.messageId !== 'string' || !/^om_[A-Za-z0-9_-]+$/.test(request.messageId) ||
        request.groupOwnerOpenId !== binding.ownerOpenId || request.groupAnchorThreadId !== binding.anchorThreadId ||
        request.trustedMemberApprovedAt !== binding.control.trustedMemberApprovedAt ||
        request.trustedMemberEffectiveFrom !== binding.control.trustedMemberEffectiveFrom) return false;
    const role = supplementalGroupMessageDisposition({ chatType: 'group', chatId: request.chatId,
      messageId: request.messageId, senderId: request.senderId, senderType: request.senderType,
      mentionedBot: request.mentionedBot, createTime: request.sourceCreateTime, content: '' }, binding.ownerOpenId, binding);
    return ['owner-task', 'trusted-member-task'].includes(role);
  }
  requestEvidence(request) {
    return Object.fromEntries(['requestId', 'messageId', 'chatId', 'appId', 'desktopThreadId', 'groupOwnerOpenId', 'groupAnchorThreadId', 'senderId', 'sourceCreateTime',
      'senderType', 'mentionedBot', 'trustedMemberApprovedAt', 'trustedMemberEffectiveFrom'].map((key) => [key, request[key]]));
  }
  validJob(job) {
    return Boolean(job && typeof job.id === 'string' && job.id && job.groupId === this.#groupId &&
      ['queued', 'sending', 'uncertain', 'sent', 'rejected'].includes(job.status) && ['text', 'image', 'file'].includes(job.type) && typeof job.sourceMessageId === 'string' && /^om_[A-Za-z0-9_-]+$/.test(job.sourceMessageId) &&
      (!this.#binding || job.appId === this.#binding.appId && job.desktopThreadId === this.#binding.threadId &&
        this.validRequest(job.request) && job.request.messageId === job.sourceMessageId &&
        job.replyInThread === (job.request.replyInThread === true)));
  }
  scopeMetadata() {
    return this.#binding ? { groupId: this.#groupId, appId: this.#binding.appId, desktopThreadId: this.#binding.threadId } : {};
  }
  matchesStateScope(state) {
    return !this.#binding || state?.groupId === this.#groupId && state.appId === this.#binding.appId && state.desktopThreadId === this.#binding.threadId;
  }
  async assertBindingPaths() {
    if (!this.#binding) return;
    this.assertBindingScope();
    const key = (value) => resolve(value).toLowerCase();
    if (key(await realpath(this.workspace)) !== key(this.#binding.groupWorkspace) ||
        key(await realpath(dirname(this.statePath))) !== key(dirname(this.#binding.paths.mediaStatePath))) throw new Error('media-binding-realpath-mismatch');
    for (const file of [this.statePath, `${this.statePath}.inbox.json`]) {
      try { if (key(await realpath(file)) !== key(file)) throw new Error('media-state-realpath-mismatch'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  serial(operation) {
    const task = this.tail.then(operation, operation);
    this.tail = task.catch(() => {});
    return task;
  }
  async initialize() {
    await this.assertBindingPaths();
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.jobs) || !this.matchesStateScope(state)) throw new Error('invalid-media-state');
      this.jobs = state.jobs;
      for (const job of this.jobs) {
        if (job?.status === 'sending') job.status = 'uncertain';
        if (this.#binding && !this.validJob(job)) {
          if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error('invalid-media-job');
          if (job.status !== 'uncertain') job.status = 'rejected';
          job.errorCode = 'media-job-scope-mismatch';
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.persist();
    this.timer = setInterval(() => { void this.process().catch(() => this.logger({ event: 'media-process-failed' })); }, 5000);
    this.timer.unref?.();
    await this.process();
  }
  async persist() {
    await this.assertBindingPaths();
    const temporary = `${this.statePath}.tmp-${process.pid}`;
    await writeFile(temporary, JSON.stringify({ version: 1, ...this.scopeMetadata(), jobs: this.jobs }, null, 2), 'utf8');
    await rename(temporary, this.statePath);
  }
  async validateImage(filePath) {
    this.assertBindingScope();
    const root = await realpath(this.workspace);
    if (this.#binding && relative(this.#binding.groupWorkspace, root)) throw new Error('media-workspace-binding-mismatch');
    const target = await realpath(resolve(filePath.replaceAll('/', '\\')));
    const local = relative(root, target);
    if (!local || local.startsWith('..') || isAbsolute(local) || !/\.(png|jpe?g|webp)$/i.test(target)) throw new Error('image-outside-group-workspace');
    if ((await stat(target)).size > 64 * 1024 * 1024) throw new Error('image-size-invalid');
    const bytes = await readFile(target);
    if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('image-size-invalid');
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpg = bytes[0] === 255 && bytes[1] === 216;
    const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !jpg && !webp) throw new Error('image-format-invalid');
    const prepared = await prepareGroupImage({ bytes, sourcePath: target, workspace: this.workspace });
    return { ...prepared, target: prepared.targetPath };
  }
  async validateArchive(filePath) {
    this.assertBindingScope();
    const root = await realpath(this.workspace);
    if (this.#binding && relative(this.#binding.groupWorkspace, root)) throw new Error('media-workspace-binding-mismatch');
    const target = await realpath(resolve(filePath.replaceAll('/', '\\')));
    const local = relative(root, target);
    if (!local || local.startsWith('..') || isAbsolute(local) || !/\.zip$/i.test(target)) throw new Error('archive-outside-group-workspace');
    if ((await stat(target)).size > 30 * 1024 * 1024) throw new Error('archive-invalid');
    const bytes = await readFile(target);
    if (bytes.length < 4 || bytes.length > 30 * 1024 * 1024 || bytes[0] !== 80 || bytes[1] !== 75) throw new Error('archive-invalid');
    return { target, bytes };
  }
  enqueueFromAnswer(request, answer) {
    return this.serial(async () => {
      this.assertBindingScope();
      if (!this.validRequest(request)) throw new Error('media-request-scope-mismatch');
      const candidates = [...String(answer).matchAll(/\]\(<?([A-Za-z]:[\\/][^\r\n)]+\.(?:png|jpe?g|webp|zip))>?\)/gi)].map((match) => match[1]);
      for (const filePath of new Set(candidates)) {
        let image;
        const type = /\.zip$/i.test(filePath) ? 'file' : 'image';
        try { image = type === 'file' ? await this.validateArchive(filePath) : await this.validateImage(filePath); } catch { continue; }
        const id = createHash('sha256').update(request.messageId).update(image.target).update(image.bytes).digest('hex');
        if (this.jobs.some((job) => job.id === id)) continue;
        this.jobs.push({ id, type, groupId: this.#groupId, sourceMessageId: request.messageId, filePath: image.target,
          ...(this.#binding ? { ...this.scopeMetadata(), request: { ...this.requestEvidence(request), replyInThread: request.replyInThread === true } } : {}),
          replyInThread: request.replyInThread === true, status: 'queued', createdAt: Date.now() });
      }
      await this.persist();
    }).then(() => this.process());
  }
  process() {
    return this.serial(async () => {
      await this.assertBindingPaths();
      try {
        const inbox = JSON.parse(await readFile(`${this.statePath}.inbox.json`, 'utf8'));
        if (inbox.version !== 1 || !Array.isArray(inbox.jobs) || !this.matchesStateScope(inbox)) throw new Error('invalid-media-inbox');
        let changed = false;
        for (const job of inbox.jobs) {
          if (typeof job?.id !== 'string' || this.jobs.some((existing) => existing.id === job.id)) continue;
          if (job.groupId !== this.#groupId || !['text', 'image', 'file'].includes(job.type)) continue;
          if (this.#binding && (job.status !== 'queued' || !this.validJob(job))) continue;
          if (job.type === 'text' && (typeof job.text !== 'string' || !job.text.trim() || job.text.length > 5000)) continue;
          this.jobs.push({ ...job, status: 'queued', createdAt: Date.now() }); changed = true;
        }
        if (changed) await this.persist();
      } catch (error) { if (error.code !== 'ENOENT') this.logger({ event: 'media-inbox-invalid' }); }
      for (const job of this.jobs) {
        if (this.closed) return;
        if (job.status !== 'queued' || job.groupId !== this.#groupId || typeof job.sourceMessageId !== 'string' || !job.sourceMessageId.startsWith('om_')) continue;
        if (this.#binding && !this.validJob(job)) { job.status = 'rejected'; job.errorCode = 'media-job-scope-mismatch'; await this.persist(); continue; }
        if (job.type === 'text' && this.#binding && (typeof job.text !== 'string' || !job.text.trim() || job.text.length > 5000)) { job.status = 'rejected'; job.errorCode = 'invalid-text'; await this.persist(); continue; }
        try {
          this.assertBindingScope();
          const originals = await this.channel.fetchRawMessage(job.sourceMessageId);
          const original = originals.find((message) => message.message_id === job.sourceMessageId);
          if (!original || original.chat_id !== this.#groupId || original.deleted) throw new Error('invalid-original-message');
          if (this.#binding) {
            const sender = original.sender;
            const rawTime = Number(original.create_time ?? original.createTime);
            const sourceTime = rawTime < 100_000_000_000 ? rawTime * 1000 : rawTime;
            if ((sender?.id ?? original.sender_id) !== job.request.senderId ||
                (sender?.sender_type ?? sender?.type ?? original.sender_type) !== 'user' ||
                !Number.isSafeInteger(sourceTime) || sourceTime !== job.request.sourceCreateTime) throw new Error('original-request-evidence-mismatch');
          }
        } catch { job.status = 'rejected'; job.errorCode = 'original-message-not-verified'; await this.persist(); continue; }
        let image;
        try { image = job.type === 'text' ? null : job.type === 'file' ? await this.validateArchive(job.filePath) : await this.validateImage(job.filePath); }
        catch { job.status = 'rejected'; job.errorCode = 'invalid-image'; await this.persist(); continue; }
        job.status = 'sending'; await this.persist();
        try {
          const input = job.type === 'text' ? { text: job.text } : job.type === 'file' ? { file: { source: image.bytes, fileName: basename(image.target) } } : { image: { source: image.bytes } };
          this.assertBindingScope();
          const receipt = await this.channel.send(this.#groupId, input, {
            replyTo: job.sourceMessageId, ...(job.replyInThread ? { replyInThread: true } : {})
          });
          if (!receipt?.messageId) throw new Error('missing-receipt');
          job.status = 'sent'; job.messageId = receipt.messageId; job.sentAt = Date.now();
          try {
            const rows = await this.channel.fetchRawMessage(receipt.messageId);
            job.readBackVerified = rows.some((message) => message.message_id === receipt.messageId && message.chat_id === this.#groupId && message.msg_type === (job.type === 'text' ? 'text' : job.type === 'file' ? 'file' : 'image') && message.parent_id === job.sourceMessageId);
          } catch { job.readBackVerified = false; }
          this.logger({ event: job.type === 'text' ? 'reply-sent' : job.type === 'file' ? 'file-sent' : 'image-sent', groupId: this.#groupId, messageId: receipt.messageId });
        } catch {
          // Upload/send uncertainty must never cause automatic duplicate sends.
          job.status = 'uncertain'; job.errorCode = 'upload-or-send-failed';
          this.logger({ event: 'image-send-uncertain', groupId: this.#groupId });
        }
        await this.persist();
      }
    });
  }
  async close() { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; await this.tail; }
}
