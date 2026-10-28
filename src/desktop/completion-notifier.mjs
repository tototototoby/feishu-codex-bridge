const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{8,128}$/;
const MESSAGE_ID_RE = /^om_[A-Za-z0-9_-]+$/;
const NOTICE_BODY = "本次处理已有结果，请查看任务卡片。";

function isDeleted(message) {
  return message?.deleted === true || message?.deleted === "true" || message?.is_deleted === true || message?.is_deleted === "true";
}

function mentionId(mention) {
  return typeof mention?.id === "string" ? mention.id : mention?.id?.open_id ?? mention?.open_id;
}

function isOwnedMessage(message, request, messageId) {
  return message?.message_id === messageId && message.chat_id === request.chatId && !isDeleted(message) &&
    message.sender?.sender_type === "app" && message.sender?.id_type === "app_id" && message.sender?.id === request.appId;
}

function isTransientReadFailure(error) {
  const status = Number(error?.response?.status ?? error?.status ?? error?.statusCode ?? error?.cause?.status);
  if (Number.isInteger(status) && status >= 400) return status === 408 || status === 429 || status >= 500 && status <= 599;
  const code = String(error?.code ?? error?.cause?.code ?? "");
  return /^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ERR_NETWORK|UND_ERR_[A-Z_]+)$/.test(code) ||
    ["TimeoutError", "AbortError"].includes(error?.name) || /network|fetch failed|socket|timed?\s*out/i.test(String(error?.message ?? ""));
}

async function verifyGroupNotice(request, channel, chatId) {
  if (request.completionNoticePolicyVersion !== 1 || request.chatId !== chatId ||
      channel.opts?.appId !== request.appId || !OPEN_ID_RE.test(request.senderId ?? "") ||
      request.completionNoticeRecipientOpenId !== request.senderId || request.senderType !== "user" || request.mentionedBot !== true ||
      request.completionNoticeSourceMessageId !== request.messageId || !MESSAGE_ID_RE.test(request.messageId ?? "") ||
      request.status !== "replied" || !MESSAGE_ID_RE.test(request.replyMessageId ?? "") || typeof channel.fetchRawMessage !== "function") {
    throw new Error("completion-notice-group-binding-unverified");
  }
  const sources = await channel.fetchRawMessage(request.messageId);
  const source = sources?.find((item) => item.message_id === request.messageId);
  if (!source || source.chat_id !== chatId || isDeleted(source) || source.sender?.sender_type !== "user" ||
      source.sender?.id_type !== "open_id" || source.sender?.id !== request.senderId) throw new Error("completion-notice-source-unverified");
  const botOpenId = channel.botIdentity?.openId;
  if (!Array.isArray(source.mentions) || !source.mentions.some((mention) => mentionId(mention) === request.appId ||
      OPEN_ID_RE.test(botOpenId ?? "") && mentionId(mention) === botOpenId)) throw new Error("completion-notice-source-mention-unverified");
  const replies = await channel.fetchRawMessage(request.replyMessageId);
  const reply = replies?.find((item) => item.message_id === request.replyMessageId);
  if (!isOwnedMessage(reply, request, request.replyMessageId) || reply.parent_id !== request.messageId ||
      !["interactive", "text", "post"].includes(reply.msg_type)) throw new Error("completion-notice-result-unverified");
  if (reply.msg_type === "interactive") {
    let card;
    try { card = JSON.parse(reply.body?.content ?? "null"); } catch {}
    if (card?.schema !== "2.0") throw new Error("completion-notice-result-incomplete");
    const title = card.header?.title?.content;
    if (card.config?.streaming_mode === true || title === "桌面任务进度") throw new Error("completion-notice-result-not-ready");
    if (!["任务回复", "任务已暂停"].includes(title)) throw new Error("completion-notice-result-incomplete");
  }
  return reply;
}

function noticeResultLink(channel, chatId, resultMessage) {
  const host = channel?.opts?.tenant === "lark" ? "applink.larksuite.com" : "applink.feishu.cn";
  const position = resultMessage?.message_position;
  return `https://${host}/client/chat/open?openChatId=${encodeURIComponent(chatId)}` +
    (Number.isSafeInteger(Number(position)) && Number(position) > 0 && /^(?:[1-9][0-9]*)$/.test(String(position)) ? `&position=${position}` : "");
}

function noticeText(request, resultLink) {
  const recipient = request?.completionNoticeMode === "mention_requester"
    ? `<at user_id="${request.completionNoticeRecipientOpenId}"></at> ` : "";
  return `${recipient}🔔 ${NOTICE_BODY}\n打开聊天查看结果：${resultLink}`;
}

/**
 * Send the optional post-completion text notice once. The caller persists the
 * pending intent with the confirmed reply receipt before entering this helper.
 */
export async function sendCompletionNoticeOnce({ request, channel, chatId, persist }) {
  if (!request?.completionNoticeEligible || request.completionNoticeState !== "pending") {
    return { kind: "skipped" };
  }

  let createMessage;
  try {
    createMessage = channel?.rawClient?.im?.v1?.message?.create;
  } catch {
    return { kind: "pre-send", code: "completion-notice-client-unavailable" };
  }
  if (typeof createMessage !== "function" || typeof chatId !== "string" || !chatId.startsWith("oc_")) {
    return { kind: "pre-send", code: "completion-notice-client-unavailable" };
  }

  const requestId = typeof request.requestId === "string" ? request.requestId : "";
  const uuid = `completion-${requestId}`;
  if (!requestId || uuid.length > 50) {
    return { kind: "pre-send", code: "completion-notice-invalid-request" };
  }

  const groupMention = request.completionNoticeMode === "mention_requester";
  let resultMessage;
  if (groupMention) {
    try {
      resultMessage = await verifyGroupNotice(request, channel, chatId);
    } catch (error) {
      if (request.completionNoticeState !== "pending") return { kind: "skipped" };
      if (error?.message === "completion-notice-result-not-ready" || isTransientReadFailure(error)) {
        request.completionNoticeError = error?.message === "completion-notice-result-not-ready"
          ? error.message : "completion-notice-read-temporary";
        await persist().catch(() => {});
        return { kind: "pre-send", code: request.completionNoticeError };
      }
      // A missing, withdrawn or mismatched source/result is a terminal skip.
      request.completionNoticeState = "skipped";
      request.completionNoticeError = error?.message?.startsWith("completion-notice-") ? error.message : "completion-notice-read-unavailable";
      await persist().catch(() => {});
      return { kind: "skipped", code: request.completionNoticeError };
    }
  }

  // Verification performs reads; another caller may have already claimed this intent.
  if (request.completionNoticeState !== "pending") return { kind: "skipped" };
  request.completionNoticeState = "sending";
  request.completionNoticeUuid = uuid;
  request.completionNoticeAttemptedAt = Date.now();
  try {
    await persist();
  } catch {
    request.completionNoticeState = "pending";
    request.completionNoticeUuid = null;
    request.completionNoticeAttemptedAt = null;
    return { kind: "pre-send", code: "completion-notice-state-unavailable" };
  }

  const resultLink = noticeResultLink(channel, chatId, resultMessage);
  const text = noticeText(request, resultLink);
  let response;
  try {
    response = await channel.rawClient.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
        uuid,
      },
    });
  } catch {
    request.completionNoticeState = "uncertain";
    request.completionNoticeError = "send-uncertain";
    await persist().catch(() => {});
    return { kind: "uncertain" };
  }

  const messageId = response?.data?.message_id;
  if (response?.code !== 0 || typeof messageId !== "string" || !messageId) {
    request.completionNoticeState = "uncertain";
    request.completionNoticeError = "receipt-unconfirmed";
    await persist().catch(() => {});
    return { kind: "uncertain" };
  }

  request.completionNoticeState = "sent";
  request.completionNoticeMessageId = messageId;
  request.completionNoticeSentAt = Date.now();
  request.completionNoticeError = null;
  if (groupMention) request.completionNoticeReadbackStatus = "unverified";
  await persist().catch(() => {});
  if (groupMention) {
    // A confirmed send is never resent, even if subsequent delivery readback fails.
    try {
      const rows = await channel.fetchRawMessage(messageId);
      const notice = rows?.find((item) => item.message_id === messageId);
      const mentions = notice?.mentions;
      const readbackText = JSON.parse(notice?.body?.content ?? "null")?.text;
      request.completionNoticeReadbackStatus = isOwnedMessage(notice, request, messageId) && notice.msg_type === "text" &&
        Array.isArray(mentions) && mentions.length === 1 && mentionId(mentions[0]) === request.completionNoticeRecipientOpenId &&
        typeof readbackText === "string" && readbackText.includes(NOTICE_BODY) && readbackText.includes(resultLink) ? "verified" : "failed";
    } catch {
      request.completionNoticeReadbackStatus = "failed";
    }
    if (request.completionNoticeReadbackStatus !== "verified") request.completionNoticeError = "completion-notice-readback-unverified";
    await persist().catch(() => {});
  }
  return groupMention ? { kind: "sent", messageId, readbackStatus: request.completionNoticeReadbackStatus } : { kind: "sent", messageId };
}
