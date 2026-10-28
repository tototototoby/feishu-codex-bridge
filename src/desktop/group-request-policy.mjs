// Request selection is independent of native-thread scheduling and permissions.
// Only host-normalized routing fields may nominate a platform reference.
const MESSAGE_ID = /^om_[A-Za-z0-9_-]+$/;
const preparedEnvelopes = new WeakSet();
const MAX_REFERENCE_MESSAGES = 12;
const MAX_REFERENCE_CHARS = 8_000;
const SHORT_CONFIRMATION = /^(?:是|好|好的|继续|可以|行|对|对的|同意|确认|yes|ok|continue)[。！!\s]*$/i;

function withoutMentions(content) {
  return content.replace(/<at\b[^>]*>[\s\S]*?<\/at>|@_user_\d+/g, " ").trim();
}

function timestamp(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number < 100_000_000_000 ? number * 1000 : number;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function referenceText(value) {
  if (typeof value !== "string") return "";
  return value.slice(0, 4_000)
    .replace(/https?:\/\/[^\s<>"']*[?&](?:signature|sign|token|access_token|key|credential|x-amz-[^=\s&]+)=[^\s<>"']*/gi, "[redacted signed URL]")
    .replace(/(?:Bearer\s+[A-Za-z0-9._~+\/-]+=*|\bsk-[A-Za-z0-9_-]{12,})/gi, "[redacted credential]")
    .replace(/^.*(?:__bridge_cb|__claude_cb|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[=:]).*$/gim, "[redacted credential or callback]")
    .replace(/\b(?:img|file)_[A-Za-z0-9_-]+\b/g, "[attachment reference]");
}

function rawText(raw) {
  let content = raw.body?.content ?? raw.content ?? "";
  if (typeof content === "string") {
    try { content = JSON.parse(content); } catch { return content; }
  }
  if (typeof content?.text === "string") return content.text;
  return typeof content === "object" && content !== null ? JSON.stringify(content) : "";
}

function quotedResultCardText(raw, appId) {
  if (raw.msg_type !== "interactive" || raw.sender?.sender_type !== "app" ||
      raw.sender?.id !== appId || raw.sender?.id_type !== "app_id") return "";
  let card;
  try { card = JSON.parse(raw.body?.content ?? "null"); } catch { return ""; }
  if (card?.schema !== "2.0" || card.config?.streaming_mode === true ||
      !["任务回复", "任务已暂停"].includes(card.header?.title?.content)) return "";
  const text = [];
  let remainingNodes = 100;
  function visit(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 6 || remainingNodes-- <= 0) return;
    if (["markdown", "plain_text"].includes(node.tag)) {
      if (node.text_size !== "notation" && typeof node.content === "string") text.push(node.content.slice(0, 4_000));
      return;
    }
    // Walk only display containers. Buttons, actions, URLs in callbacks and all
    // other card DSL fields are deliberately outside this reference projection.
    if (node.tag === "column_set" && Array.isArray(node.columns)) {
      for (const column of node.columns.slice(0, 12)) visit(column, depth + 1);
    } else if (node.tag === "column" && Array.isArray(node.elements)) {
      for (const element of node.elements.slice(0, 24)) visit(element, depth + 1);
    } else if (node.tag === "div") {
      visit(node.text, depth + 1);
    }
  }
  for (const element of (Array.isArray(card.body?.elements) ? card.body.elements : []).slice(0, 24)) visit(element);
  return referenceText(text.join("\n\n"));
}

export function isPreparedGroupTaskEnvelope(envelope, msg, groupId) {
  return preparedEnvelopes.has(envelope) && envelope.groupId === groupId &&
    envelope.sourceMessageId === msg?.messageId && envelope.actorOpenId === msg?.senderId;
}

export function correlateGroupTask(envelope, knownRequests = []) {
  const anchors = new Set(envelope.verifiedReferenceMessageIds);
  const requests = [...knownRequests].filter((request) => request.chatId === envelope.groupId && request.appId === envelope.appId &&
    request.senderType === "user" && request.mentionedBot === true &&
    !["identity_review_required", "source_withdrawn", "cancelled_before_send"].includes(request.status));
  const matching = (id) => anchors.has(id) ? requests.filter((request) =>
    [request.messageId, request.presentationMessageId, request.replyMessageId].includes(id)) : [];
  const parentMatches = matching(envelope.parentMessageId);
  // A verified direct reply identifies the task more precisely than its older root.
  // A complete same-actor human parent can instead supply this new request's scope.
  const matches = parentMatches.length ? parentMatches : envelope.quotedInstructionMessageId ? [] : matching(envelope.rootMessageId);
  const unique = [...new Map(matches.map((request) => [request.requestId, request])).values()];
  // Referencing another person's request supplies material, never their authority.
  const followup = unique.length === 1 && unique[0].senderId === envelope.actorOpenId ? unique[0] : null;
  return Object.freeze({ ...envelope,
    relation: followup ? "followup" : unique.length > 1 || envelope.needsClarification ? "ambiguous" : "new",
    followupRequestId: followup?.requestId ?? null,
    referencedRequestIds: unique.map((request) => request.requestId),
  });
}

export async function prepareGroupRequestContext({ msg, context, channel, groupId, appId, ownerOpenId }) {
  if (msg?.chatType !== "group" || msg.chatId !== groupId || context?.groupId !== groupId ||
      channel?.opts?.appId !== appId || !MESSAGE_ID.test(msg.messageId ?? "") ||
      typeof msg.senderId !== "string" || !msg.senderId) throw new Error("group-request-context-scope-mismatch");
  const binding = context.binding;
  if (binding && (binding.groupId !== groupId || binding.appId !== appId || binding.ownerOpenId !== ownerOpenId ||
      context.appId !== appId || context.desktopThreadId !== binding.threadId)) throw new Error("group-request-context-binding-mismatch");
  const sourceTime = timestamp(msg.createTime);
  const parentMessageId = MESSAGE_ID.test(msg.replyToMessageId ?? "") ? msg.replyToMessageId : null;
  const rootMessageId = MESSAGE_ID.test(msg.rootId ?? "") ? msg.rootId : null;
  const candidates = [...new Set([parentMessageId, rootMessageId].filter((id) => id && id !== msg.messageId))].slice(0, 3);
  const verified = [];
  const messages = [];
  for (const id of candidates) {
    if (!sourceTime || typeof channel.fetchRawMessage !== "function") continue;
    try {
      const originals = await channel.fetchRawMessage(id);
      const raw = Array.isArray(originals) ? originals.find((item) => item?.message_id === id && item.chat_id === groupId &&
        item.deleted !== true && item.deleted !== "true" && item.is_deleted !== true &&
        timestamp(item.create_time ?? item.createTime) !== null && timestamp(item.create_time ?? item.createTime) <= sourceTime) : null;
      if (!raw) continue;
      const updatedAt = timestamp(raw.update_time ?? raw.updateTime);
      // A later edit cannot explain the meaning of an earlier short confirmation.
      if (updatedAt !== null && updatedAt > sourceTime) continue;
      verified.push(id);
      const senderType = raw.sender?.sender_type ?? raw.sender?.type ?? raw.sender_type;
      const content = rawText(raw);
      const resultCardText = quotedResultCardText(raw, appId);
      // Only an explicitly quoted, owned final/pause card supplies bot text.
      // Ambient bot echoes and all progress-card bodies remain excluded.
      if (!resultCardText && (senderType !== "user" || /<!--\s*feishu-(?:progress|reply):/.test(content))) continue;
      const projectedContent = resultCardText || referenceText(content);
      const parentText = withoutMentions(content);
      // Only a complete, unchanged text projection may supplement current scope.
      // Truncated/redacted material could omit a cancellation or a narrower limit.
      const quotedInstruction = id === parentMessageId && raw.msg_type === "text" &&
        raw.sender?.sender_type === "user" && raw.sender?.id_type === "open_id" && raw.sender?.id === msg.senderId &&
        content.length <= 4_000 && projectedContent === content && parentText.length > 0 &&
        !SHORT_CONFIRMATION.test(parentText) && !/<!--|__bridge_cb|__claude_cb/.test(content);
      messages.push({ messageId: id, senderId: referenceText(raw.sender?.id ?? raw.sender_id ?? ""),
        senderType: resultCardText ? "app" : "user", timestamp: new Date(timestamp(raw.create_time ?? raw.createTime)).toISOString(),
        msgType: referenceText(raw.msg_type ?? "unknown"), content: projectedContent, referenceOnly: !quotedInstruction,
        ...(quotedInstruction ? { contextRole: "quoted_instruction" } : {}) });
    } catch { /* Unavailable or withdrawn references confer no context or attachment access. */ }
  }
  // History is material only when this message explicitly requests a group recap.
  const asksForHistory = /(?:总结|概括|回顾|查看|整理).{0,12}(?:群聊|(?:本群|群里|群内).{0,10}(?:聊天|消息|讨论|对话))|(?:刚才大家讨论|群里最近对话)/.test(msg.content ?? "");
  if (asksForHistory && sourceTime) {
    const seen = new Set(messages.map((record) => record.messageId));
    for (const record of (Array.isArray(context.messages) ? context.messages : []).slice().reverse()) {
      if (messages.length >= MAX_REFERENCE_MESSAGES) break;
      const recordTime = timestamp(record?.timestampMs ?? record?.timestamp);
      if (!record || seen.has(record.messageId) || record.messageId === msg.messageId || record.deleted ||
          record.senderType !== "user" || !recordTime || recordTime > sourceTime ||
          /<!--\s*feishu-(?:progress|reply):/.test(record.content ?? "")) continue;
      seen.add(record.messageId);
      messages.push({ messageId: referenceText(record.messageId), senderId: referenceText(record.senderId),
        senderName: referenceText(record.senderName), senderType: "user", timestamp: new Date(recordTime).toISOString(),
        msgType: referenceText(record.msgType), content: referenceText(record.content), referenceOnly: true });
    }
  }
  // Ordinary questions never inherit unanchored history or another active task.
  const referenceContext = { source: referenceText(context.source ?? "group-reference"), groupId,
    syncStatus: { historyMayBeIncomplete: context.syncStatus?.backfillStatus !== "complete" ||
      context.syncStatus?.incrementalStatus === "partial" || Boolean(context.syncStatus?.lastErrorCategory) },
    messages: messages.slice(0, MAX_REFERENCE_MESSAGES) };
  while (JSON.stringify(referenceContext).length > MAX_REFERENCE_CHARS && referenceContext.messages.length) referenceContext.messages.pop();
  const quotedInstruction = referenceContext.messages.find((record) => record.contextRole === "quoted_instruction");
  const content = typeof msg.content === "string" ? withoutMentions(msg.content) : "";
  const needsClarification = SHORT_CONFIRMATION.test(content) && !quotedInstruction &&
    !(Array.isArray(msg.resources) && msg.resources.length);
  const taskEnvelope = Object.freeze({ version: 1, groupId, appId, sourceMessageId: msg.messageId,
    actorOpenId: msg.senderId, ownerOpenId, parentMessageId, rootMessageId, sourceCreateTime: sourceTime,
    quotedInstructionMessageId: quotedInstruction?.messageId ?? null,
    quotedInstructionActorOpenId: quotedInstruction?.senderId ?? null,
    verifiedReferenceMessageIds: Object.freeze(verified), needsClarification });
  preparedEnvelopes.add(taskEnvelope);
  return { referenceContext, allowedAttachmentMessageIds: Object.freeze([msg.messageId, ...verified]), taskEnvelope };
}
