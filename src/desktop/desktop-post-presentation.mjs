const INITIAL_PROGRESS = "正在处理…";
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

/**
 * One ordinary rich-text reply, replaced in place for its entire lifetime.
 * The dispatcher must persist its create intent before constructing this class.
 * A create without a confirmed receipt is never retried here (including after
 * restart); only GET and replacement PUTs for a known message id are retryable.
 */
export class DesktopPostPresentation {
  constructor({
    channel, chatId, sourceMessageId, replyInThread = true,
    previousMessageId, previousReactionId, resumed = false,
    onMessageId = () => {}, onReactionId = () => {}, onError = () => {},
  }) {
    Object.assign(this, { channel, chatId, sourceMessageId, replyInThread,
      previousMessageId, previousReactionId, resumed, onMessageId, onReactionId, onError });
    this.messageId = null;
    this.streamMessageId = null;
    this.latestContent = INITIAL_PROGRESS;
    this.persistedContent = null;
    this.closed = false;
    this.writeFailed = false;
    this.retryable = false;
    this.lastFailureApiCode = null;
    this.finishIntent = null;
    this.finishTask = null;
    this.updateTask = null;
    this.reactionId = null;
    this.reactionPromise = Promise.resolve(null);
    this.removedReactionIds = new Set();
    this.cleanupStarted = false;
    this.previousReactionCleanup = Promise.resolve();
    this.startPromise = this.start();
  }

  async start() {
    if (this.replyInThread !== true || !this.sourceMessageId || !this.chatId ||
        !this.channel?.rawClient?.im?.v1?.message) {
      this.writeFailed = true;
      this.reportError("post-start", "thread-required");
      return null;
    }
    // A resumed create intent without an id is uncertain, never a new send.
    if (this.resumed && !this.previousMessageId) {
      this.writeFailed = true;
      this.reportError("post-resume", "receipt-missing");
      return null;
    }
    if (this.previousMessageId) return this.resumeKnownMessage();
    this.startTyping();
    const initialContent = this.latestContent;
    try {
      // SDK types/index.d.ts: message.reply accepts content/msg_type and
      // reply_in_thread. Do not use channel.send's retry/fallback wrapper.
      const response = await this.channel.rawClient.im.v1.message.reply({
        path: { message_id: this.sourceMessageId },
        data: {
          msg_type: "post", reply_in_thread: true,
          content: JSON.stringify(buildPostContent(initialContent)),
        },
      });
      const messageId = response?.data?.message_id;
      if (!hasApiSuccessCode(response) || typeof messageId !== "string" || !messageId) {
        this.writeFailed = true;
        this.reportError("post-send", "unconfirmed", response);
        return null;
      }
      this.messageId = messageId;
      this.streamMessageId = messageId;
      this.persistedContent = initialContent;
      await this.saveMessageId();
      return messageId;
    } catch (error) {
      // Even a transport timeout can follow a successful server-side create.
      // Preserve the dispatcher's intent and never issue a second reply.
      this.writeFailed = true;
      this.reportError("post-send", "unconfirmed", error);
      return null;
    }
  }

  async resumeKnownMessage() {
    const messageId = this.previousMessageId;
    const result = await this.withReadRetry(async () => {
      const source = await this.channel.rawClient.im.v1.message.get({
        path: { message_id: this.sourceMessageId },
      });
      if (!hasApiSuccessCode(source)) return source;
      const reply = await this.channel.rawClient.im.v1.message.get({
        path: { message_id: messageId },
      });
      if (!hasApiSuccessCode(reply)) return reply;
      return { code: 0, source, reply };
    }, "post-resume");
    if (!result) return null;
    if (!isOwnedPost(result.reply, result.source, messageId, this)) {
      this.writeFailed = true;
      this.retryable = false;
      this.reportError("post-resume", "identity-or-thread-mismatch");
      return null;
    }
    this.messageId = messageId;
    this.streamMessageId = messageId;
    this.retryable = false;
    await this.saveMessageId();
    this.startTyping();
    return messageId;
  }

  async withReadRetry(operation, phase) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let result;
      try { result = await operation(); } catch (error) { result = error; }
      if (hasApiSuccessCode(result)) return result;
      if (!isTransientRestError(result)) {
        this.writeFailed = true;
        this.retryable = false;
        this.reportError(phase, "unconfirmed", result);
        return null;
      }
      this.retryable = true;
      this.reportError(phase, "retryable", result);
      if (attempt + 1 < MAX_ATTEMPTS) await delay(RETRY_BASE_MS * 2 ** attempt);
    }
    return null;
  }

  async saveMessageId() {
    try { await this.onMessageId(this.messageId); }
    catch { this.reportError("message-state", "save-failed"); }
  }

  async update(content) {
    if (this.closed || this.finishIntent || this.writeFailed) return false;
    this.latestContent = normalizePostContent(content);
    await this.startPromise;
    if (this.closed || this.finishIntent) return false;
    if (!this.messageId && this.previousMessageId && this.retryable) {
      await this.resumeSingleFlight();
    }
    return this.enqueueUpdate();
  }

  resumeSingleFlight() {
    if (!this.resumeTask) {
      this.resumeTask = this.resumeKnownMessage().finally(() => { this.resumeTask = null; });
    }
    return this.resumeTask;
  }

  enqueueUpdate() {
    if (!this.messageId || this.writeFailed || this.closed) return Promise.resolve(false);
    if (!this.updateTask) {
      this.updateTask = this.flushLatestContent().finally(() => { this.updateTask = null; });
    }
    return this.updateTask;
  }

  async flushLatestContent() {
    while (!this.closed && !this.writeFailed && this.persistedContent !== this.latestContent) {
      const content = this.latestContent;
      if (!await this.replaceContent(content)) return false;
      this.persistedContent = content;
    }
    return !this.writeFailed && this.persistedContent === this.latestContent;
  }

  async replaceContent(content) {
    let plainFallback = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let result;
      try {
        // SDK types/index.d.ts:264345 requires data.msg_type/content and
        // path.message_id. This is a full, idempotent PUT of the same post.
        result = await this.channel.rawClient.im.v1.message.update({
          path: { message_id: this.messageId },
          data: {
            msg_type: "post",
            content: JSON.stringify(buildPostContent(content, { plain: plainFallback })),
          },
        });
      } catch (error) { result = error; }
      if (hasApiSuccessCode(result)) {
        this.retryable = false;
        this.lastFailureApiCode = null;
        return true;
      }
      // The installed SDK classifies these explicit API codes as format
      // errors. Fall back only on a replacement PUT; never create again.
      const { apiCode } = numericFailureDetails(result);
      this.lastFailureApiCode = apiCode ?? null;
      if (!plainFallback && apiCode === 230001 && attempt + 1 < MAX_ATTEMPTS) {
        plainFallback = true;
        continue;
      }
      if (!isTransientRestError(result)) {
        this.writeFailed = true;
        this.retryable = false;
        this.reportError("post-update", "unconfirmed", result);
        return false;
      }
      this.retryable = true;
      this.reportError("post-update", "retryable", result);
      if (attempt + 1 < MAX_ATTEMPTS) await delay(RETRY_BASE_MS * 2 ** attempt);
    }
    return false;
  }

  finish(content, state = "completed", successTheme = true) {
    if (this.finishTask) return this.finishTask;
    if (!this.finishIntent) {
      this.finishIntent = { content: normalizePostContent(content), state, successTheme };
    }
    const task = this.finishOnce().then((result) => {
      if (result.kind === "retryable" && this.finishTask === task) this.finishTask = null;
      return result;
    });
    this.finishTask = task;
    return task;
  }

  async finishOnce() {
    this.latestContent = this.finishIntent.content;
    await this.startPromise;
    if (!this.messageId && this.previousMessageId && this.retryable && !this.writeFailed) {
      await this.resumeSingleFlight();
    }
    if (this.updateTask) await this.updateTask;
    const updated = !this.closed && !this.writeFailed && this.messageId
      ? await this.enqueueUpdate() : false;
    await this.cleanupTyping();
    if (updated && this.persistedContent === this.finishIntent.content) {
      this.closed = true;
      return { kind: "streamed", receipt: { messageId: this.messageId } };
    }
    if (this.retryable && !this.writeFailed) {
      return { kind: "retryable", messageId: this.messageId || this.previousMessageId };
    }
    this.closed = true;
    return { kind: "uncertain", messageId: this.messageId || this.previousMessageId || null };
  }

  pause(content = this.latestContent) { return this.finish(content, "paused", false); }
  shutdown(content = this.latestContent) { return this.pause(content); }

  async close() {
    this.closed = true;
    await this.startPromise;
    if (this.updateTask) await this.updateTask;
    await this.cleanupTyping();
  }

  startTyping() {
    if (this.typingStarted || this.closed) return;
    this.typingStarted = true;
    if (this.previousReactionId && typeof this.channel.removeReaction === "function") {
      this.previousReactionCleanup = this.removeReaction(this.previousReactionId);
    }
    if (typeof this.channel.addReaction !== "function") return;
    this.reactionPromise = Promise.resolve()
      .then(() => this.channel.addReaction(this.sourceMessageId, "Typing"))
      .then(async (reactionId) => {
        if (typeof reactionId !== "string" || !reactionId) return null;
        this.reactionId = reactionId;
        try { await this.onReactionId(reactionId); }
        catch { this.reportError("reaction-state", "save-failed"); }
        if (this.cleanupStarted) await this.removeReaction(reactionId);
        return reactionId;
      }).catch(() => null);
  }

  async cleanupTyping() {
    if (this.cleanupStarted) return;
    this.cleanupStarted = true;
    await this.previousReactionCleanup;
    const result = await Promise.race([
      this.reactionPromise.then((reactionId) => ({ settled: true, reactionId })),
      delay(1_000).then(() => ({ settled: false })),
    ]);
    if (result.settled && result.reactionId) await this.removeReaction(result.reactionId);
    if (!result.settled) void this.reactionPromise.then((id) => { if (id) void this.removeReaction(id); });
  }

  async removeReaction(reactionId) {
    if (this.removedReactionIds.has(reactionId)) return;
    this.removedReactionIds.add(reactionId);
    try { await this.channel.removeReaction(this.sourceMessageId, reactionId); }
    catch { this.reportError("reaction-cleanup", "failed"); }
    if (this.reactionId === reactionId) this.reactionId = null;
    try { await this.onReactionId(this.reactionId); }
    catch { this.reportError("reaction-state", "save-failed"); }
  }

  reportError(phase, code, value) {
    try { this.onError({ phase, code, ...numericFailureDetails(value) }); }
    catch { /* Presentation telemetry cannot trigger a second delivery. */ }
  }
}

export function buildPostContent(content, { plain = false } = {}) {
  const text = normalizePostContent(content);
  // Same native md shape as the installed SDK's markdownToPost converter.
  // A format-rejected update can use valid plain post paragraphs on this id.
  return { zh_cn: { title: "", content: plain
    ? text.split("\n").map((line) => [{ tag: "text", text: line || " " }])
    : [[{ tag: "md", text }]] } };
}

export function normalizePostContent(content) {
  // GroupMedia owns uploads. Never put image localURLs, filesystem targets,
  // or HTML image sources in a message's markdown.
  let text = String(content ?? "")
    .replace(/!\[([^\]]*)\]\([^\n]*?\)/g, (_, alt) => alt ? `图片：${alt}` : "图片附件")
    .replace(/<img\b[^>]*>/gi, "图片附件")
    .replace(/\[([^\]]+)\]\(([^\n]*?)\)/g, (link, label, target) =>
      /^(?:https?:\/\/|mailto:)/i.test(target.trim()) ? link : label)
    .replace(/(?:file|local|vscode|codex):(?:\/\/)?[^\s<>"'`，。；）]+/gi, "[本地文件]")
    .replace(/\b[a-z]:[\\/][^\r\n<>"'`，。；）]+/gi, "[本地文件]")
    .replace(/\\\\[^\s<>"'`，。；）]+/g, "[本地文件]")
    .replace(/(^|[\s("'`=])\/(?!\/)[^\s<>"'`，。；）]+/g, "$1[本地文件]");
  text = text.replace(/\r\n?/g, "\n");
  return text.trim() ? text : INITIAL_PROGRESS;
}

function isOwnedPost(replyResponse, sourceResponse, messageId, presentation) {
  const reply = replyResponse?.data?.items?.find((item) => item.message_id === messageId);
  const source = sourceResponse?.data?.items?.find((item) => item.message_id === presentation.sourceMessageId);
  const appId = presentation.channel.opts?.appId;
  const sender = reply?.sender;
  if (!source || !reply || isDeleted(source) || isDeleted(reply) ||
      source.chat_id !== presentation.chatId || reply.chat_id !== presentation.chatId ||
      reply.msg_type !== "post" || reply.parent_id !== presentation.sourceMessageId ||
      reply.root_id !== (source.root_id || source.message_id) ||
      typeof reply.thread_id !== "string" || !reply.thread_id ||
      (source.thread_id && source.thread_id !== reply.thread_id) ||
      typeof appId !== "string" || !appId || sender?.sender_type !== "app" ||
      sender.id_type !== "app_id" || sender.id !== appId) return false;
  try {
    const post = JSON.parse(reply.body?.content ?? "null");
    return Array.isArray((post?.zh_cn ?? post)?.content);
  } catch { return false; }
}

function isDeleted(message) {
  return [message?.deleted, message?.is_deleted].some((value) => value === true || value === "true");
}

function hasApiSuccessCode(response) { return response?.code === 0; }

function numericFailureDetails(value) {
  const status = value?.response?.status ?? value?.status;
  const apiCode = value?.response?.data?.code ?? value?.data?.code ?? value?.apiCode ??
    (typeof value?.code === "number" ? value.code : undefined);
  const extCode = value?.response?.data?.error?.ext_code ?? value?.error?.ext_code ?? value?.extCode;
  return {
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(Number.isInteger(apiCode) && apiCode >= 0 ? { apiCode } : {}),
    ...(Number.isInteger(extCode) ? { extCode } : {}),
  };
}

function isTransientRestError(value) {
  const { status } = numericFailureDetails(value);
  if ([401, 403].includes(status)) return false;
  if (status === 408 || status === 429 || status >= 500 && status <= 599) return true;
  const code = value?.code ?? value?.cause?.code;
  return ["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"].includes(code) ||
    /socket disconnected before secure tls connection|socket hang up/i.test(String(value?.message ?? ""));
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
