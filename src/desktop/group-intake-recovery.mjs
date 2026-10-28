import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

const MESSAGE_ID = /^om_[A-Za-z0-9_-]+$/;
const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const MAX_ENTRIES = 200;
const MAX_ATTEMPTS = 3;
const STATUSES = new Set(["pending", "dispatching", "handled", "hold_network", "hold_review", "hold_invalid", "hold_no_receipt"]);

function milliseconds(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 100_000_000_000 ? number : null;
}

function command(content) {
  const text = content.trim();
  return /^[\/／]/.test(text) || /^(?:stop|help|status|new|reset|resume|cd|ws)(?:\s|$)/i.test(text) ||
    /^(?:停止|停止任务|停止当前任务|停止当前群任务|群助手管理者要求停止当前群任务)(?:[。！!\s]|$)/.test(text);
}

// One live bridge instance owns this journal. It is deliberately separate from
// Desktop state: an uncertain native submission must never become a new attempt.
export function createGroupIntakeRecovery({ statePath, groupId, appId, channel, normalize, onMessage, hasRequest, logger }) {
  if (!isAbsolute(statePath ?? "") || !/^oc_[A-Za-z0-9_-]+$/.test(groupId ?? "") ||
      !/^cli_[A-Za-z0-9_-]+$/.test(appId ?? "") || !channel ||
      ![normalize, onMessage, hasRequest].every((fn) => typeof fn === "function")) {
    throw new Error("group-intake-recovery-config-invalid");
  }
  let entries = null;
  let timer = null;
  let running = null;
  let closed = false; // Fatal journal failure; ordinary shutdown only sets stopping.
  let stopping = false;

  function log(event, entry) {
    try { logger?.({ event, groupId, messageId: entry?.messageId, status: entry?.status, attempts: entry?.attempts }); } catch {}
  }

  function persist() {
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify({ version: 1, groupId, appId, entries }, null, 2), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, statePath);
    } catch (error) {
      closed = true;
      clearInterval(timer);
      timer = null;
      if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  function load() {
    if (entries) return;
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8").replace(/^\uFEFF/, "")) : { version: 1, entries: [] };
    if (state?.version !== 1 || (state.groupId !== undefined && state.groupId !== groupId) ||
        (state.appId !== undefined && state.appId !== appId) ||
        !Array.isArray(state.entries) || state.entries.length > MAX_ENTRIES) {
      throw new Error("group-intake-recovery-state-invalid");
    }
    const seen = new Set();
    // Project only metadata, so an accidentally supplied body is never persisted.
    const parsed = state.entries.map((item) => {
      if (!MESSAGE_ID.test(item?.messageId ?? "") || seen.has(item.messageId) || !STATUSES.has(item.status) ||
          (item.attempts !== undefined && (!Number.isInteger(item.attempts) || item.attempts < 0 || item.attempts > MAX_ATTEMPTS))) {
        throw new Error("group-intake-recovery-state-invalid");
      }
      seen.add(item.messageId);
      const entry = { messageId: item.messageId, status: item.status, attempts: item.attempts ?? 0 };
      for (const key of ["createdAt", "updatedAt", "sourceCreateTime", "sourceUpdateTime"]) {
        if (milliseconds(item[key])) entry[key] = item[key];
      }
      for (const key of ["reason", "lastError"]) {
        if (typeof item[key] === "string" && /^[a-z0-9_-]{1,100}$/.test(item[key])) entry[key] = item[key];
      }
      if (entry.status === "dispatching") {
        entry.status = "hold_review";
        entry.lastError = "interrupted_after_delivery_start";
        entry.updatedAt = Date.now();
      }
      return entry;
    });
    entries = parsed;
    if (state.entries.some((item) => item.status === "dispatching")) persist();
  }

  function transition(entry, status, error) {
    entry.status = status;
    entry.updatedAt = Date.now();
    if (error) entry.lastError = error;
    else delete entry.lastError;
    persist();
    log("recovery-state", entry);
  }

  function receipt(entry) {
    const present = hasRequest(entry.messageId);
    if (typeof present !== "boolean") throw new Error("group-intake-recovery-receipt-invalid");
    if (present !== true) return false;
    if (entry.status === "handled") return true;
    transition(entry, "handled");
    return true;
  }

  function eventFromRaw(raw, messageId) {
    const now = Date.now();
    const createdAt = milliseconds(raw?.create_time);
    const updatedAt = raw?.update_time === undefined ? null : milliseconds(raw.update_time);
    const botId = channel.botIdentity?.openId;
    if (channel.opts?.appId !== appId || !OPEN_ID.test(botId ?? "") || raw?.message_id !== messageId ||
        raw.chat_id !== groupId || raw.sender?.sender_type !== "user" || raw.sender?.id_type !== "open_id" ||
        !OPEN_ID.test(raw.sender.id ?? "") || !createdAt || createdAt > now ||
        (raw.update_time !== undefined && (!updatedAt || updatedAt < createdAt || updatedAt > now)) ||
        raw.deleted === true || raw.deleted === "true" || raw.is_deleted === true || raw.is_deleted === "true" ||
        typeof raw.body?.content !== "string" || typeof raw.msg_type !== "string" || !Array.isArray(raw.mentions)) {
      throw new Error("source-invalid");
    }
    const mentions = raw.mentions.map((mention) => {
      const id = mention?.id;
      const openId = typeof id === "object" && id !== null ? id.open_id : mention?.id_type === "open_id" ? id : undefined;
      return { key: mention?.key, name: mention?.name, id: { open_id: openId } };
    });
    if (!mentions.some((mention) => mention.id.open_id === botId && typeof mention.key === "string" && mention.key.length > 0)) {
      throw new Error("source-no-bot-mention");
    }
    return {
      sender: { sender_id: { open_id: raw.sender.id }, sender_type: "user" },
      message: { message_id: messageId, chat_id: groupId, chat_type: "group", message_type: raw.msg_type,
        content: raw.body.content, create_time: String(createdAt), update_time: updatedAt ? String(updatedAt) : undefined,
        root_id: raw.root_id, parent_id: raw.parent_id, thread_id: raw.thread_id, mentions },
    };
  }

  async function recover(entry) {
    if (closed || stopping || entry.status !== "pending") return;
    try {
      if (receipt(entry)) return;
    } catch {
      transition(entry, "hold_review", "receipt_lookup_failed");
      return;
    }
    if (entry.attempts >= MAX_ATTEMPTS) {
      transition(entry, "hold_network", "read_attempts_exhausted");
      return;
    }
    entry.attempts++;
    entry.updatedAt = Date.now();
    persist();
    let raw;
    try {
      const items = await channel.fetchRawMessage(entry.messageId);
      raw = Array.isArray(items) ? items.find((item) => item?.message_id === entry.messageId) : undefined;
    } catch {
      transition(entry, entry.attempts >= MAX_ATTEMPTS ? "hold_network" : "pending", "source_read_failed");
      return;
    }
    if (closed || stopping || entry.status !== "pending") return;
    if (!raw) {
      transition(entry, entry.attempts >= MAX_ATTEMPTS ? "hold_network" : "pending", "source_unavailable");
      return;
    }
    let msg;
    try {
      const event = eventFromRaw(raw, entry.messageId);
      entry.sourceCreateTime = Number(event.message.create_time);
      if (event.message.update_time) entry.sourceUpdateTime = Number(event.message.update_time);
      msg = await normalize(event, { botIdentity: channel.botIdentity, stripBotMentions: true, includeRaw: true,
        fetchSubMessages: (id) => channel.fetchRawMessage(id) });
      if (closed || stopping || entry.status !== "pending") return;
      if (msg?.messageId !== entry.messageId || msg.chatId !== groupId || msg.chatType !== "group" ||
          msg.senderId !== raw.sender.id || msg.senderType !== "user" || msg.mentionedBot !== true ||
          msg.createTime !== entry.sourceCreateTime || !Array.isArray(msg.resources) || typeof msg.content !== "string" ||
          command(msg.content) || channel.opts?.appId !== appId) throw new Error("normalized-source-invalid");
    } catch {
      transition(entry, "hold_invalid", "source_validation_failed");
      return;
    }
    if (closed || stopping || entry.status !== "pending") return;
    try {
      // Recheck after network/normalization awaits: live intake may have won.
      if (receipt(entry)) return;
    } catch {
      transition(entry, "hold_review", "receipt_lookup_failed");
      return;
    }
    if (closed || stopping || entry.status !== "pending") return;
    transition(entry, "dispatching");
    try {
      await onMessage(msg);
      if (closed) return;
      if (stopping) {
        receipt(entry);
        return;
      }
      if (!receipt(entry)) transition(entry, "hold_no_receipt", "intake_returned_without_receipt");
    } catch {
      try {
        if (receipt(entry)) return;
      } catch {}
      transition(entry, "hold_review", "intake_or_receipt_uncertain");
    }
  }

  function drain() {
    if (closed || stopping || running) return running ?? Promise.resolve();
    const task = (async () => {
      for (const entry of entries) {
        if (closed || stopping) break;
        if (entry.status === "pending") await recover(entry);
      }
    })();
    running = task;
    task.then(() => { if (running === task) running = null; }, () => {
      if (running === task) running = null;
      // Persistence failures are fail-closed; never continue with stale disk state.
      closed = true;
      clearInterval(timer);
      timer = null;
      log("recovery-journal-unavailable");
    });
    return task;
  }

  return {
    record(messageId) {
      if (closed) throw new Error("group-intake-recovery-closed");
      if (!MESSAGE_ID.test(messageId ?? "")) throw new Error("group-intake-recovery-message-invalid");
      load();
      if (entries.some((entry) => entry.messageId === messageId)) return;
      if (entries.length >= MAX_ENTRIES) {
        const handled = entries.findIndex((entry) => entry.status === "handled");
        if (handled < 0) throw new Error("group-intake-recovery-capacity");
        entries.splice(handled, 1);
      }
      const now = Date.now();
      entries.push({ messageId, status: "pending", attempts: 0, reason: "live-task", createdAt: now, updatedAt: now });
      persist();
    },
    markHandled(messageId) {
      if (closed) throw new Error("group-intake-recovery-closed");
      load();
      const entry = entries.find((item) => item.messageId === messageId);
      return entry ? receipt(entry) : false;
    },
    start() {
      if (closed) throw new Error("group-intake-recovery-closed");
      if (stopping) return;
      load();
      if (!timer) {
        timer = setInterval(() => { void drain().catch(() => {}); }, 30_000);
        timer.unref?.();
      }
      void drain().catch(() => {});
    },
    close() {
      stopping = true;
      clearInterval(timer);
      timer = null;
    },
  };
}
