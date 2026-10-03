function noticeText(channel, chatId) {
  const host = channel?.opts?.tenant === "lark" ? "applink.larksuite.com" : "applink.feishu.cn";
  return `🔔 本次处理已有结果，请查看任务卡片。\n打开聊天查看结果：https://${host}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
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

  let response;
  try {
    response = await channel.rawClient.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text: noticeText(channel, chatId) }),
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
  await persist().catch(() => {});
  return { kind: "sent", messageId };
}
