const INITIAL_PROGRESS = "正在处理…";
const REACTION_CLEANUP_GRACE_MS = 1_000;

/**
 * Owns one Feishu request's visible progress UI. A regular interactive card is
 * sent once and replaced in place so its lifetime is not tied to CardKit
 * streaming sessions.
 */
export class DesktopPresentation {
  constructor({
    channel,
    chatId,
    sourceMessageId,
    replyInThread = false,
    previousReactionId,
    previousMessageId,
    onMessageId = () => {},
    onThreadRejected = null,
    onReactionId = () => {},
    onError = () => {},
    resumed = false,
  }) {
    this.channel = channel;
    this.chatId = chatId;
    this.sourceMessageId = sourceMessageId;
    this.replyInThread = replyInThread;
    this.previousReactionId = previousReactionId;
    this.previousMessageId = previousMessageId;
    this.onMessageId = onMessageId;
    this.onThreadRejected = onThreadRejected;
    this.threadFallbackAttempted = false;
    this.onReactionId = onReactionId;
    this.onError = onError;
    this.latestContent = normalizeProgressContent(
      resumed ? "桌面线程已恢复，正在继续处理…" : INITIAL_PROGRESS,
    );
    this.messageId = null;
    this.persistedContent = null;
    this.completed = false;
    this.persistedCompleted = false;
    this.paused = false;
    this.persistedPaused = false;
    this.writeFailed = false;
    this.progressWriteRecoveryEligible = false;
    this.finalRecoveryAttempted = false;
    this.retryAt = 0;
    this.retryFailures = 0;
    this.updateTask = null;
    this.finishTask = null;
    this.finishIntent = null;
    this.closed = false;
    this.cleanupStarted = false;
    this.removedReactionIds = new Set();
    this.reactionId = null;
    this.previousReactionCleanup = previousReactionId
      ? this.channel.removeReaction(this.sourceMessageId, previousReactionId).catch(() => {})
      : Promise.resolve();

    this.starting = false;
    this.startPromise = this.startSingleFlight();
  }

  startSingleFlight() {
    if (this.starting && this.startPromise) return this.startPromise;
    this.starting = true;
    const promise = this.start().finally(() => {
      if (this.startPromise === promise) this.starting = false;
    });
    this.startPromise = promise;
    return promise;
  }

  async start() {
    this.startTyping();
    const initialContent = this.latestContent;
    const card = buildProgressCard(initialContent);
    try {
      if (this.previousMessageId) {
        const response = await this.channel.rawClient.im.v1.message.get({
          path: { message_id: this.previousMessageId },
          params: { card_msg_content_type: "user_card_content" },
        });
        if (!hasApiSuccessCode(response) && isTransientRestError(response)) {
          this.scheduleRetry("card-resume", response);
          return null;
        }
        if (!isOwnedProgressCard(response, this.previousMessageId, this)) {
          this.writeFailed = true;
          this.reportError("card-resume", "identity-or-card-mismatch", numericFailureDetails(response));
          return null;
        }
      this.messageId = this.previousMessageId;
      this.streamMessageId = this.messageId;
      this.persistedContent = null;
      this.persistedCompleted = false;
      this.persistedPaused = false;
      this.retryAt = 0;
      this.retryFailures = 0;
      try {
        await this.onMessageId(this.messageId);
      } catch {
        this.reportError("message-state", "save-failed");
      }
      return this.messageId;
      }
      const response = await this.sendCardOnce(card);
      if (!hasApiSuccessCode(response)) {
        this.reportError("card-send", "failed", numericFailureDetails(response));
        return null;
      }
      const messageId = response?.data?.message_id;
      if (typeof messageId !== "string" || !messageId) {
        this.reportError("card-send", "failed", numericFailureDetails(response));
        return null;
      }

      this.messageId = messageId;
      this.streamMessageId = messageId;
      this.persistedContent = initialContent;
      try {
        await this.onMessageId(messageId);
      } catch {
        this.reportError("message-state", "save-failed");
      }

      if (
        this.persistedContent !== this.latestContent ||
        this.persistedCompleted !== this.completed ||
        this.persistedPaused !== this.paused
      ) {
        await this.enqueueSetContent(this.latestContent);
      }
      return messageId;
    } catch (error) {
      if (this.previousMessageId && isTransientRestError(error)) {
        this.scheduleRetry("card-resume", error);
        return null;
      }
      if (this.previousMessageId) this.writeFailed = true;
      // A failed create may have reached Feishu. Never issue a second create.
      this.reportError(this.previousMessageId ? "card-resume" : "card-send", "failed", numericFailureDetails(error));
      return null;
    }
  }

  async sendCardOnce(card) {
    const data = {
      msg_type: "interactive",
      content: JSON.stringify(card),
    };
    if (this.sourceMessageId) {
      let response;
      try {
        response = await this.channel.rawClient.im.v1.message.reply({
          path: { message_id: this.sourceMessageId },
          data: { ...data, ...(this.replyInThread ? { reply_in_thread: true } : {}) },
        });
      } catch (error) {
        if (!await this.acceptThreadRejection(error)) throw error;
        return this.channel.rawClient.im.v1.message.reply({
          path: { message_id: this.sourceMessageId }, data,
        });
      }
      if (await this.acceptThreadRejection(response)) {
        return this.channel.rawClient.im.v1.message.reply({
          path: { message_id: this.sourceMessageId }, data,
        });
      }
      return response;
    }
    return this.channel.rawClient.im.v1.message.create({
      params: { receive_id_type: detectReceiveIdType(this.chatId) },
      data: {
        receive_id: this.chatId,
        ...data,
      },
    });
  }

  async acceptThreadRejection(result) {
    if (!this.replyInThread || this.previousMessageId || this.messageId ||
        this.threadFallbackAttempted || typeof this.onThreadRejected !== "function") return false;
    const payload = result?.response?.data ?? result;
    if (![230071, 230072].includes(payload?.code) ||
        payload?.data?.message_id || payload?.message_id || result?.data?.message_id) return false;
    this.threadFallbackAttempted = true;
    if (await this.onThreadRejected(payload.code) !== true) return false;
    this.replyInThread = false;
    return true;
  }

  startTyping() {
    if (this.reactionPromise) return;
    this.reactionPromise = Promise.resolve()
      .then(() => this.channel.addReaction(this.sourceMessageId, "Typing"))
      .then(async (reactionId) => {
        if (typeof reactionId !== "string" || !reactionId) return null;
        this.reactionId = reactionId;
        try {
          await this.onReactionId(reactionId);
        } catch {
          this.reportError("reaction-state", "save-failed");
        }
        if (this.cleanupStarted) await this.removeReaction(reactionId);
        return reactionId;
      })
      .catch(() => null);
  }

  async update(content) {
    if (this.closed || this.finishIntent) return;
    this.latestContent = normalizeProgressContent(content);
    if (!this.messageId && this.previousMessageId && !this.writeFailed && Date.now() >= this.retryAt) {
      await this.startSingleFlight();
    }
    if (!this.messageId) return;
    await this.enqueueSetContent(this.latestContent);
  }

  enqueueSetContent(content) {
    this.latestContent = normalizeProgressContent(content);
    if (!this.messageId || this.writeFailed || Date.now() < this.retryAt) return Promise.resolve(false);
    if (!this.updateTask) {
      this.updateTask = this.flushLatestContent().finally(() => {
        this.updateTask = null;
        if (
          !this.writeFailed &&
          !this.closed &&
          Date.now() >= this.retryAt &&
          this.messageId &&
          (this.persistedContent !== this.latestContent ||
            this.persistedCompleted !== this.completed ||
            this.persistedPaused !== this.paused)
        ) {
          void this.enqueueSetContent(this.latestContent);
        }
      });
    }
    return this.updateTask;
  }

  async flushLatestContent() {
    while (
      !this.writeFailed &&
      (this.persistedContent !== this.latestContent ||
        this.persistedCompleted !== this.completed ||
        this.persistedPaused !== this.paused)
    ) {
      const content = this.latestContent;
      const completed = this.completed;
      const paused = this.paused;
      try {
        const response = await this.channel.rawClient.im.v1.message.patch({
          path: { message_id: this.messageId },
          data: { content: JSON.stringify(buildProgressCard(content, completed, paused, this.finishIntent?.successTheme !== false)) },
        });
        if (!hasApiSuccessCode(response)) {
          if (isTransientRestError(response)) {
            this.scheduleRetry("card-update", response);
            return false;
          }
          this.writeFailed = true;
          this.progressWriteRecoveryEligible = !completed && !paused && isRecoverableProgressFailure(response);
          this.reportError("card-update", "failed", numericFailureDetails(response));
          return false;
        }
        this.persistedContent = content;
        this.persistedCompleted = completed;
        this.persistedPaused = paused;
        if (this.retryFailures) this.reportError("card-update", "recovered");
        this.retryFailures = 0;
        this.retryAt = 0;
      } catch (error) {
        // A full replacement of this same card is idempotent. Wait for the
        // real HTTP operation to settle before a later heartbeat retries.
        if (isTransientRestError(error)) {
          this.scheduleRetry("card-update", error);
          return false;
        }
        this.writeFailed = true;
        this.progressWriteRecoveryEligible = !completed && !paused && isRecoverableProgressFailure(error);
        this.reportError("card-update", "failed", numericFailureDetails(error));
        return false;
      }
    }
    return !this.writeFailed;
  }

  finish(content, state = "completed", successTheme = true) {
    if (this.finishTask) return this.finishTask;
    if (!this.finishIntent) {
      const finalState = state === "paused" ? "paused" : "completed";
      this.finishIntent = {
        content: normalizeProgressContent(content),
        state: finalState,
        successTheme: successTheme !== false,
      };
      this.completed = finalState === "completed";
      this.paused = finalState === "paused";
    }
    let task;
    task = this.finishOnce(this.finishIntent).then((result) => {
      if (result?.kind === "retryable" && this.finishTask === task) {
        this.finishTask = null;
      }
      return result;
    });
    this.finishTask = task;
    return task;
  }

  async finishOnce(intent) {
    this.latestContent = intent.content;
    let messageId = await this.startPromise;
    for (let attempt = 0; !messageId && this.previousMessageId && !this.writeFailed && attempt < 2; attempt++) {
      if (this.retryAt > Date.now()) await delay(Math.min(60_000, this.retryAt - Date.now()));
      messageId = await this.startSingleFlight();
    }
    if (!messageId) {
      await this.cleanupTyping();
      if (this.previousMessageId && !this.writeFailed && this.retryFailures > 0) {
        return { kind: "retryable", messageId: this.previousMessageId };
      }
      this.closed = true;
      return { kind: "uncertain", messageId: this.messageId };
    }

    // Let an in-flight progress PATCH settle before checking its failure or
    // reading back the same card. finishTask serializes concurrent finishes.
    if (this.updateTask) await this.updateTask;
    let updated = false;
    if (this.writeFailed) updated = await this.recoverFinalCardOnce(intent);
    for (let attempt = 0; attempt < 3 && !this.writeFailed; attempt++) {
      if (updated) break;
      if (this.retryAt > Date.now()) await delay(Math.min(60_000, this.retryAt - Date.now()));
      updated = await this.enqueueSetContent(this.latestContent);
      if (updated) break;
    }
    if (!updated || this.writeFailed) {
      await this.cleanupTyping();
      if (!this.writeFailed && this.retryFailures > 0) {
        return { kind: "retryable", messageId: this.messageId || this.previousMessageId };
      }
      this.closed = true;
      return { kind: "uncertain", messageId: this.messageId };
    }
    this.closed = true;
    await this.cleanupTyping();
    return { kind: "streamed", receipt: { messageId: this.messageId } };
  }

  async recoverFinalCardOnce(intent) {
    if (!this.writeFailed || !this.progressWriteRecoveryEligible ||
        !this.messageId || this.finalRecoveryAttempted) return false;
    // Claim the only recovery before any await. This path never creates a
    // message or replays business work, and does not classify HTTP 400 as transient.
    this.finalRecoveryAttempted = true;
    const messageId = this.messageId;
    try {
      const response = await this.channel.rawClient.im.v1.message.get({
        path: { message_id: messageId },
        params: { card_msg_content_type: "user_card_content" },
      });
      if (!isOwnedProgressCard(response, messageId, this)) {
        this.reportError("card-final-recovery", "identity-or-card-mismatch", numericFailureDetails(response));
        return false;
      }
      const completed = intent.state === "completed";
      const paused = intent.state === "paused";
      const result = await this.channel.rawClient.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(buildProgressCard(intent.content, completed, paused, intent.successTheme)) },
      });
      if (!hasApiSuccessCode(result)) {
        this.reportError("card-final-recovery", "failed", numericFailureDetails(result));
        return false;
      }
      this.persistedContent = intent.content;
      this.persistedCompleted = completed;
      this.persistedPaused = paused;
      this.retryFailures = 0;
      this.retryAt = 0;
      this.writeFailed = false;
      this.reportError("card-final-recovery", "recovered");
      return true;
    } catch (error) {
      this.reportError("card-final-recovery", "failed", numericFailureDetails(error));
      return false;
    }
  }

  async shutdown(content = "桌面桥接暂时暂停；恢复后会继续同步。") {
    return this.finish(content, "paused");
  }

  async cleanupTyping() {
    if (this.cleanupStarted) return;
    this.cleanupStarted = true;
    await this.previousReactionCleanup;
    const result = await Promise.race([
      this.reactionPromise.then((reactionId) => ({ settled: true, reactionId })),
      delay(REACTION_CLEANUP_GRACE_MS).then(() => ({ settled: false })),
    ]);
    if (result.settled) {
      if (result.reactionId) await this.removeReaction(result.reactionId);
      return;
    }
    void this.reactionPromise.then((reactionId) => {
      if (reactionId) void this.removeReaction(reactionId);
    });
  }

  async removeReaction(reactionId) {
    if (this.removedReactionIds.has(reactionId)) return;
    this.removedReactionIds.add(reactionId);
    try {
      await this.channel.removeReaction(this.sourceMessageId, reactionId);
    } catch {
      this.reportError("reaction-cleanup", "failed");
    }
    this.reactionId = null;
    try {
      await this.onReactionId(null);
    } catch {
      this.reportError("reaction-state", "save-failed");
    }
  }

  scheduleRetry(phase, error) {
    this.retryFailures++;
    this.retryAt = Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(this.retryFailures - 1, 5));
    this.reportError(phase, "transport-retry-scheduled", numericFailureDetails(error));
  }

  reportError(phase, code, details) {
    try {
      this.onError({ phase, code, ...numericFailureDetails(details) });
    } catch {
      // Presentation telemetry must not affect request delivery.
    }
  }
}

function buildProgressCard(content, completed = false, paused = false, successTheme = completed) {
  const theme = completed && !paused && successTheme ? "green" : "blue";
  const visibleContent = normalizeProgressContent(content);
  const title = paused ? "任务已暂停" : completed ? "任务回复" : "桌面任务进度";
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default" },
    header: {
      title: { tag: "plain_text", content: title },
      subtitle: {
        tag: "plain_text",
        content: paused ? "恢复后继续同步" : completed ? "桌面任务已完成" : "结果会更新在此卡片中",
      },
      template: theme,
      icon: { tag: "standard_icon", token: "ai-common_colorful" },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 20px 12px",
      vertical_spacing: "8px",
      elements: [
        {
          tag: "column_set",
          flex_mode: "none",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              background_style: `${theme}-50`,
              padding: "12px",
              vertical_spacing: "4px",
              elements: [
                {
                  tag: "markdown",
                  content: `**${paused ? "暂停时进度" : completed ? "回复内容" : "当前进度"}**\n\n${visibleContent}`,
                },
              ],
            },
          ],
        },
        {
          tag: "markdown",
          content: paused ? "任务已暂停，恢复后会继续处理。" : completed ? "任务已完成。" : "进度会在本卡片中持续更新。",
          text_size: "notation",
        },
      ],
    },
  };
}

function normalizeProgressContent(content) {
  // GroupMedia owns file upload and image-message delivery. Card markdown
  // accepts Feishu image keys, never local filesystem paths or web URLs.
  const text = String(content ?? "").replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (image, alt, target) =>
    /^img_[a-z0-9_-]+$/i.test(target) ? image : `**图片：${alt || "附件"}**`)
    .replace(/\[([^\]]+)\]\((?:[a-z]:[\\/]|file:\/\/|\/)[^)]+\)/gi, "$1");
  return text.trim() ? text : "正在处理，稍后同步进展。";
}

function hasApiSuccessCode(response) {
  return typeof response?.code === "number" && response.code === 0;
}

function isOwnedProgressCard(response, messageId, presentation) {
  if (!hasApiSuccessCode(response)) return false;
  const message = response?.data?.items?.find((item) => item.message_id === messageId);
  const sender = message?.sender;
  if (!message || message.chat_id !== presentation.chatId ||
      message.parent_id !== presentation.sourceMessageId || message.msg_type !== "interactive" ||
      message.deleted === true || message.deleted === "true" ||
      message.is_deleted === true || message.is_deleted === "true" ||
      sender?.sender_type !== "app" || sender?.id_type !== "app_id" ||
      typeof presentation.channel.opts?.appId !== "string" ||
      !presentation.channel.opts.appId || sender?.id !== presentation.channel.opts.appId) return false;
  try {
    const card = JSON.parse(message.body?.content ?? "null");
    return card?.schema === "2.0" && card?.config?.streaming_mode !== true &&
      ["桌面任务进度", "任务回复", "任务已暂停"].includes(card?.header?.title?.content);
  } catch {
    return false;
  }
}

function isRecoverableProgressFailure(value) {
  const { status, apiCode, extCode } = numericFailureDetails(value);
  return status !== 401 && status !== 403 && apiCode === 230099 && extCode === 11310;
}

function numericFailureDetails(value) {
  const status = value?.response?.status ?? value?.status;
  const apiCode = value?.response?.data?.code ?? value?.data?.code ?? value?.apiCode ??
    (typeof value?.code === "number" ? value.code : undefined);
  // Only extract the numeric extension from the SDK response message. Do not
  // include its payload or message text in telemetry; retain sanitized details.
  const responseMessage = value?.response?.data?.msg;
  const extCode = value?.extCode ?? (typeof responseMessage === "string"
    ? Number(responseMessage.match(/\bext\s*=\s*ErrCode:\s*(\d+)\b/i)?.[1]) : undefined);
  const details = {};
  if (Number.isInteger(status) && status >= 100 && status <= 599) details.status = status;
  if (Number.isInteger(apiCode) && apiCode >= 0) details.apiCode = apiCode;
  if (Number.isInteger(extCode) && extCode >= 0) details.extCode = extCode;
  return details;
}

function isTransientRestError(error) {
  const { status } = numericFailureDetails(error);
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return true;
  const code = error?.code ?? error?.cause?.code;
  if (["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"].includes(code)) return true;
  return /socket disconnected before secure tls connection|socket hang up/i.test(String(error?.message ?? ""));
}

function detectReceiveIdType(to) {
  if (typeof to !== "string" || !to) throw new Error("empty receive_id");
  if (to.startsWith("oc_")) return "chat_id";
  if (to.startsWith("ou_")) return "open_id";
  if (to.startsWith("on_")) return "union_id";
  if (to.includes("@")) return "email";
  return "user_id";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
