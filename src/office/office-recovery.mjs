import { lstat, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadOfficeAssistantFromProcess } from "./office-policy.mjs";

let queue = Promise.resolve();
const safeId = (value) => typeof value === "string" && /^om_[A-Za-z0-9_-]+$/.test(value);

async function readJson(path, fallback) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error("recovery-file-invalid");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicJson(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

export function claimOfficeMessage(message) {
  const operation = queue.then(async () => {
    const assistant = loadOfficeAssistantFromProcess({ requireReady: true });
    if (!safeId(message?.messageId) || message.chatType !== "p2p" || message.senderId !== assistant.allowedOpenId) return false;
    const path = join(assistant.bridgeHome, ".office-inbound-ledger.json");
    const ledger = await readJson(path, { schemaVersion: 1, appId: assistant.appId, messages: {} });
    if (ledger.schemaVersion !== 1 || ledger.appId !== assistant.appId || !ledger.messages || typeof ledger.messages !== "object" || Array.isArray(ledger.messages)) throw new Error("inbound-ledger-invalid");
    if (Object.hasOwn(ledger.messages, message.messageId)) return false;
    ledger.messages[message.messageId] = { chatId: message.chatId, at: new Date().toISOString(), status: "claimed" };
    const entries = Object.entries(ledger.messages);
    if (entries.length > 8192) ledger.messages = Object.fromEntries(entries.slice(-8192));
    await atomicJson(path, ledger);
    return true;
  });
  queue = operation.catch(() => {});
  return operation;
}

export async function recoverOfficeMessages(channel, accept) {
  const assistant = loadOfficeAssistantFromProcess({ requireReady: true });
  const path = join(assistant.bridgeHome, ".office-recovery-inbox.json");
  const inbox = await readJson(path, null);
  if (!inbox) return;
  if (inbox.schemaVersion !== 1 || inbox.appId !== assistant.appId || !Array.isArray(inbox.requests) || inbox.requests.length > 50) throw new Error("recovery-inbox-invalid");
  for (const request of inbox.requests) {
    if (request.status !== "queued") continue;
    if (!safeId(request.messageId) || request.senderId !== assistant.allowedOpenId || !/^oc_[A-Za-z0-9_-]+$/.test(request.chatId ?? "")) throw new Error("recovery-request-invalid");
    let message;
    try {
      const result = await channel.rawClient.im.v1.message.get({ path: { message_id: request.messageId }, params: { user_id_type: "open_id" } });
      if (result?.code !== 0) throw new Error("message-read-unavailable");
      const source = result?.data?.items?.find((item) => item.message_id === request.messageId);
      if (source?.sender?.sender_type !== "user" || source.sender.id_type !== "open_id" || source.sender.id !== request.senderId || source.chat_id !== request.chatId) throw new Error("message-source-mismatch");
      if (source.msg_type !== "text") {
        request.status = "manual_recovery_required";
        request.errorCode = "unsupported-recovery-message-type";
        await atomicJson(path, inbox);
        continue;
      }
      const body = JSON.parse(source.body?.content ?? "null");
      if (typeof body?.text !== "string") throw new Error("message-content-unavailable");
      message = { messageId: source.message_id, chatId: source.chat_id, chatType: "p2p", senderId: source.sender.id,
        senderType: "user", senderIsBot: false, content: body.text, rawContentType: "text", resources: [], mentions: [],
        mentionAll: false, mentionedBot: false, replyToMessageId: source.parent_id, createTime: Number(source.create_time) };
    } catch {
      request.errorCode = "message-read-unavailable";
      await atomicJson(path, inbox);
      continue;
    }
    if (!message || message.messageId !== request.messageId || message.chatId !== request.chatId || message.chatType !== "p2p" || message.senderId !== request.senderId) {
      request.status = "rejected";
      request.errorCode = "message-identity-mismatch";
      await atomicJson(path, inbox);
      continue;
    }
    // The shared intake claims the same durable message ID as live events.
    // A crash after claiming never causes an automatic duplicate execution.
    await accept(message);
    request.status = "accepted";
    request.errorCode = null;
    request.acceptedAt = new Date().toISOString();
    await atomicJson(path, inbox);
  }
}
