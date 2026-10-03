import { readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import { FIXED_GROUP_ID } from './group-recorder.mjs';
import { prepareGroupImage } from './group-image-size.mjs';

export class GroupMedia {
  constructor({ channel, workspace, statePath, logger = () => {} }) {
    this.channel = channel; this.workspace = workspace; this.statePath = statePath; this.logger = logger;
    this.jobs = []; this.tail = Promise.resolve(); this.timer = null; this.closed = false;
  }
  serial(operation) {
    const task = this.tail.then(operation, operation);
    this.tail = task.catch(() => {});
    return task;
  }
  async initialize() {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.jobs)) throw new Error('invalid-media-state');
      this.jobs = state.jobs;
      for (const job of this.jobs) if (job.status === 'sending') job.status = 'uncertain';
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.persist();
    this.timer = setInterval(() => { void this.process().catch(() => this.logger({ event: 'media-process-failed' })); }, 5000);
    this.timer.unref?.();
    await this.process();
  }
  async persist() {
    const temporary = `${this.statePath}.tmp-${process.pid}`;
    await writeFile(temporary, JSON.stringify({ version: 1, jobs: this.jobs }, null, 2), 'utf8');
    await rename(temporary, this.statePath);
  }
  async validateImage(filePath) {
    const root = await realpath(this.workspace);
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
    const root = await realpath(this.workspace);
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
      const candidates = [...String(answer).matchAll(/\]\(<?([A-Za-z]:[\\/][^\r\n)]+\.(?:png|jpe?g|webp|zip))>?\)/gi)].map((match) => match[1]);
      for (const filePath of new Set(candidates)) {
        let image;
        const type = /\.zip$/i.test(filePath) ? 'file' : 'image';
        try { image = type === 'file' ? await this.validateArchive(filePath) : await this.validateImage(filePath); } catch { continue; }
        const id = createHash('sha256').update(request.messageId).update(image.target).update(image.bytes).digest('hex');
        if (this.jobs.some((job) => job.id === id)) continue;
        this.jobs.push({ id, type, groupId: FIXED_GROUP_ID, sourceMessageId: request.messageId, filePath: image.target,
          replyInThread: request.replyInThread === true, status: 'queued', createdAt: Date.now() });
      }
      await this.persist();
    }).then(() => this.process());
  }
  process() {
    return this.serial(async () => {
      try {
        const inbox = JSON.parse(await readFile(`${this.statePath}.inbox.json`, 'utf8'));
        if (inbox.version !== 1 || !Array.isArray(inbox.jobs)) throw new Error('invalid-media-inbox');
        let changed = false;
        for (const job of inbox.jobs) {
          if (typeof job?.id !== 'string' || this.jobs.some((existing) => existing.id === job.id)) continue;
          if (job.groupId !== FIXED_GROUP_ID || !['text', 'image', 'file'].includes(job.type)) continue;
          if (job.type === 'text' && (typeof job.text !== 'string' || !job.text.trim() || job.text.length > 5000)) continue;
          this.jobs.push({ ...job, status: 'queued', createdAt: Date.now() }); changed = true;
        }
        if (changed) await this.persist();
      } catch (error) { if (error.code !== 'ENOENT') this.logger({ event: 'media-inbox-invalid' }); }
      for (const job of this.jobs) {
        if (this.closed) return;
        if (job.status !== 'queued' || job.groupId !== FIXED_GROUP_ID || typeof job.sourceMessageId !== 'string' || !job.sourceMessageId.startsWith('om_')) continue;
        try {
          const originals = await this.channel.fetchRawMessage(job.sourceMessageId);
          const original = originals.find((message) => message.message_id === job.sourceMessageId);
          if (!original || original.chat_id !== FIXED_GROUP_ID || original.deleted) throw new Error('invalid-original-message');
        } catch { job.status = 'rejected'; job.errorCode = 'original-message-not-verified'; await this.persist(); continue; }
        let image;
        try { image = job.type === 'text' ? null : job.type === 'file' ? await this.validateArchive(job.filePath) : await this.validateImage(job.filePath); }
        catch { job.status = 'rejected'; job.errorCode = 'invalid-image'; await this.persist(); continue; }
        job.status = 'sending'; await this.persist();
        try {
          const input = job.type === 'text' ? { text: job.text } : job.type === 'file' ? { file: { source: image.bytes, fileName: basename(image.target) } } : { image: { source: image.bytes } };
          const receipt = await this.channel.send(FIXED_GROUP_ID, input, {
            replyTo: job.sourceMessageId, ...(job.replyInThread ? { replyInThread: true } : {})
          });
          if (!receipt?.messageId) throw new Error('missing-receipt');
          job.status = 'sent'; job.messageId = receipt.messageId; job.sentAt = Date.now();
          try {
            const rows = await this.channel.fetchRawMessage(receipt.messageId);
            job.readBackVerified = rows.some((message) => message.message_id === receipt.messageId && message.chat_id === FIXED_GROUP_ID && message.msg_type === (job.type === 'text' ? 'text' : job.type === 'file' ? 'file' : 'image') && message.parent_id === job.sourceMessageId);
          } catch { job.readBackVerified = false; }
          this.logger({ event: job.type === 'text' ? 'reply-sent' : job.type === 'file' ? 'file-sent' : 'image-sent', groupId: FIXED_GROUP_ID, messageId: receipt.messageId });
        } catch {
          // Upload/send uncertainty must never cause automatic duplicate sends.
          job.status = 'uncertain'; job.errorCode = 'upload-or-send-failed';
          this.logger({ event: 'image-send-uncertain', groupId: FIXED_GROUP_ID });
        }
        await this.persist();
      }
    });
  }
  async close() { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; await this.tail; }
}
