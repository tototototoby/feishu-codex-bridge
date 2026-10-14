import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_BYTES = 26 * 1024 * 1024;
const MAX_OUTPUTS = 16;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const FILE_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip", ".txt", ".md", ".csv", ".tsv", ".rtf", ".odt", ".ods", ".odp"]);
const ZIP_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx", ".zip", ".odt", ".ods", ".odp"]);
const OLE_EXTENSIONS = new Set([".doc", ".xls", ".ppt"]);
const JOB_STATUSES = new Set(["queued", "sending", "sent", "uncertain", "rejected"]);
const MESSAGE_ID_RE = /^om_[A-Za-z0-9_-]{8,128}$/;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const OLE_MAGIC = Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]);

/** Only explicitly marked output links may become durable attachment sends. */
export class OfficeNativeMedia {
  constructor({ channel, workspace, statePath, chatId, allowedSenderId, appId, logger = () => {} }) {
    if (!/^oc_[0-9a-f]{32}$/.test(chatId ?? "") || !/^ou_[A-Za-z0-9_-]{8,128}$/.test(allowedSenderId ?? "") ||
      !/^cli_[A-Za-z0-9_-]{8,128}$/.test(appId ?? "") || !isAbsolute(workspace ?? "") || !isAbsolute(statePath ?? "") ||
      typeof channel?.send !== "function" || typeof channel?.fetchRawMessage !== "function" || channel?.opts?.appId !== appId) {
      throw new Error("invalid-office-native-media-binding");
    }
    this.channel = channel;
    this.workspace = resolve(workspace);
    this.statePath = statePath;
    this.binding = Object.freeze({ chatId, allowedSenderId, appId });
    this.logger = logger;
    this.jobs = [];
    this.tail = Promise.resolve();
    this.initializing = null;
    this.timer = null;
    this.closed = false;
  }

  serial(operation) {
    const task = this.tail.then(operation, operation);
    this.tail = task.catch(() => {});
    return task;
  }

  initialize() {
    if (this.closed) return Promise.reject(new Error("office-native-media-closed"));
    if (this.initializing) return this.initializing;
    this.initializing = this.serial(async () => {
      try {
        const state = JSON.parse((await readFile(this.statePath, "utf8")).replace(/^\uFEFF/, ""));
        if (state.version !== 1 || !sameBinding(state.binding, this.binding) || !Array.isArray(state.jobs) ||
          !state.jobs.every((job) => validJob(job, this.binding))) throw new Error("invalid-office-native-media-state");
        this.jobs = state.jobs;
        for (const job of this.jobs) if (job.status === "sending") job.status = "uncertain";
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await this.persist();
      if (!this.closed) {
        this.timer = setInterval(() => { void this.process().catch(() => this.log("media-process-failed")); }, 5000);
        this.timer.unref?.();
      }
    }).then(() => this.process());
    return this.initializing;
  }

  async persist() {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, binding: this.binding, jobs: this.jobs }, null, 2), { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.statePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async validateOutput(filePath) {
    if (!isAbsolute(filePath)) throw new Error("media-path-not-absolute");
    const root = await realpath(this.workspace);
    const outputRoot = await realpath(join(this.workspace, "output"));
    const target = await realpath(resolve(filePath));
    if (!within(root, outputRoot) || !within(outputRoot, target)) throw new Error("media-outside-office-output");
    const extension = extname(target).toLowerCase();
    const type = IMAGE_EXTENSIONS.has(extension) ? "image" : FILE_EXTENSIONS.has(extension) ? "file" : null;
    const info = await stat(target);
    if (!type || !info.isFile() || info.size < 1 || info.size > MAX_BYTES) throw new Error("media-size-or-type-invalid");
    const bytes = await readFile(target);
    if (!bytes.length || bytes.length > MAX_BYTES || bytes.length !== info.size) throw new Error("media-size-invalid");
    const png = bytes.subarray(0, 8).equals(PNG_MAGIC);
    const jpg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (type === "image" && !(extension === ".png" ? png : extension === ".webp" ? webp : jpg)) throw new Error("media-image-magic-invalid");
    if (extension === ".pdf" && bytes.toString("ascii", 0, 5) !== "%PDF-") throw new Error("media-pdf-magic-invalid");
    if (ZIP_EXTENSIONS.has(extension) && !(bytes.length >= 4 && bytes[0] === 80 && bytes[1] === 75 &&
      ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6) || (bytes[2] === 7 && bytes[3] === 8)))) throw new Error("media-zip-magic-invalid");
    if (OLE_EXTENSIONS.has(extension) && !bytes.subarray(0, 8).equals(OLE_MAGIC)) throw new Error("media-office-magic-invalid");
    if (extension === ".rtf" && !bytes.toString("ascii", 0, 5).startsWith("{\\rtf")) throw new Error("media-rtf-magic-invalid");
    if ([".txt", ".md", ".csv", ".tsv"].includes(extension) && bytes.includes(0)) throw new Error("media-text-invalid");
    return { target, bytes, type, contentHash: hash(bytes) };
  }

  async verifyOriginal(messageId) {
    if (this.channel?.opts?.appId !== this.binding.appId || !MESSAGE_ID_RE.test(messageId ?? "")) throw new Error("media-channel-or-source-invalid");
    const originals = await this.channel.fetchRawMessage(messageId);
    const original = Array.isArray(originals) && originals.find((message) => message?.message_id === messageId);
    if (!original || original.chat_id !== this.binding.chatId || original.deleted || original.sender?.sender_type !== "user" ||
      original.sender?.id !== this.binding.allowedSenderId || (original.sender.id_type && original.sender.id_type !== "open_id")) {
      throw new Error("media-original-message-not-verified");
    }
    return original;
  }

  async enqueueFromAnswer(request, answer) {
    await this.initialize();
    return this.serial(async () => {
      if (this.closed) throw new Error("office-native-media-closed");
      if (request?.chatId !== this.binding.chatId || request?.senderId !== this.binding.allowedSenderId ||
        request?.appId !== this.binding.appId || !MESSAGE_ID_RE.test(request.messageId ?? "")) throw new Error("media-request-binding-mismatch");
      const candidates = markedOutputPaths(answer);
      if (!candidates.length) return;
      await this.verifyOriginal(request.messageId);
      for (const filePath of candidates) {
        let output;
        try { output = await this.validateOutput(filePath); }
        catch { this.log("media-output-rejected", { sourceMessageId: request.messageId }); continue; }
        // One source/path is one delivery intent. A file replaced after an
        // uncertain upload must not become a new send merely by changing bytes.
        const id = hash(JSON.stringify([this.binding, request.messageId, output.target]));
        if (this.jobs.some((job) => job.id === id)) continue;
        this.jobs.push({ id, ...this.binding, sourceMessageId: request.messageId, filePath: output.target,
          contentHash: output.contentHash, type: output.type, replyInThread: request.replyInThread === true,
          status: "queued", createdAt: Date.now() });
      }
      await this.persist();
    }).then(() => this.process());
  }

  process() {
    return this.serial(async () => {
      for (const job of this.jobs) {
        if (this.closed) return;
        if (job.status !== "queued") continue;
        let output;
        try {
          if (!validJob(job, this.binding)) throw new Error("media-job-binding-mismatch");
          await this.verifyOriginal(job.sourceMessageId);
          output = await this.validateOutput(job.filePath);
          if (output.contentHash !== job.contentHash || output.type !== job.type) throw new Error("media-output-changed");
        } catch {
          job.status = "rejected"; job.errorCode = "source-or-output-not-verified";
          await this.persist();
          this.log("media-job-rejected", { sourceMessageId: job.sourceMessageId });
          continue;
        }
        // This durable state precedes the upload inside channel.send. Restart or
        // transport ambiguity must never automatically repeat that side effect.
        job.status = "sending"; job.attemptedAt = Date.now();
        await this.persist();
        if (this.closed) { job.status = "queued"; await this.persist(); return; }
        try {
          const input = job.type === "image" ? { image: { source: output.bytes } } :
            { file: { source: output.bytes, fileName: basename(output.target) } };
          const receipt = await this.channel.send(this.binding.chatId, input, {
            replyTo: job.sourceMessageId, ...(job.replyInThread ? { replyInThread: true } : {}),
          });
          if (!MESSAGE_ID_RE.test(receipt?.messageId ?? "")) throw new Error("media-receipt-missing");
          job.messageId = receipt.messageId;
          job.status = "sent"; job.sentAt = Date.now();
          // Persist the receipt before readback; failure to read a sent message
          // is evidence uncertainty, never a reason to send again.
          await this.persist();
          try {
            const rows = await this.channel.fetchRawMessage(receipt.messageId);
            job.readBackVerified = Array.isArray(rows) && rows.some((message) => message?.message_id === receipt.messageId &&
              message.chat_id === this.binding.chatId && message.msg_type === job.type && !message.deleted &&
              message.parent_id === job.sourceMessageId && message.sender?.sender_type === "app" && message.sender?.id === this.binding.appId);
          } catch { job.readBackVerified = false; }
          this.log("media-sent", { sourceMessageId: job.sourceMessageId, messageId: receipt.messageId, readBackVerified: job.readBackVerified });
        } catch {
          job.status = "uncertain"; job.errorCode = "upload-send-or-state-uncertain";
          this.log("media-send-uncertain", { sourceMessageId: job.sourceMessageId });
        }
        await this.persist();
      }
    });
  }

  log(event, data = {}) {
    try { this.logger({ event, chatId: this.binding.chatId, appId: this.binding.appId, ...data }); } catch {}
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tail;
  }
}

function within(root, target) {
  const local = relative(root, target);
  return local !== "" && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

function sameBinding(left, right) {
  return left?.chatId === right.chatId && left?.allowedSenderId === right.allowedSenderId && left?.appId === right.appId;
}

function validJob(job, binding) {
  return sameBinding(job, binding) && /^[0-9a-f]{64}$/.test(job?.id ?? "") && /^[0-9a-f]{64}$/.test(job?.contentHash ?? "") &&
    MESSAGE_ID_RE.test(job?.sourceMessageId ?? "") && isAbsolute(job?.filePath ?? "") &&
    ["image", "file"].includes(job.type) && JOB_STATUSES.has(job.status);
}

function markedOutputPaths(answer) {
  const regions = [...String(answer).matchAll(/<!-- office-output:start -->([\s\S]*?)<!-- office-output:end -->/g)];
  const paths = new Set();
  for (const region of regions) {
    for (const match of region[1].matchAll(/\]\((?:<([^>\r\n]+)>|([^\s)]+))\)/g)) {
      let candidate = match[1] ?? match[2];
      if (/^\/[A-Za-z]:[\\/]/.test(candidate)) candidate = candidate.slice(1);
      if (/^[A-Za-z]:[\\/]/.test(candidate)) paths.add(candidate);
      if (paths.size >= MAX_OUTPUTS) return [...paths];
    }
  }
  return [...paths];
}
