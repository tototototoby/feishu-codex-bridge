import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { sendCompletionNoticeOnce } from "../desktop/completion-notifier.mjs";
import { DesktopPresentation } from "../desktop/desktop-presentation.mjs";

const activeRuns = new Map();
const HEARTBEAT_MS = 10_000;
const MIN_UPDATE_INTERVAL_MS = 700;
const MAX_PROGRESS_CHARS = 16_000;
const MAX_COMMENTARY_BLOCKS = 3;
const MAX_TOOL_BLOCKS = 6;
const MAX_NOTICE_RECORDS = 32;
const MAX_NOTICE_BYTES = 64 * 1024;
const NOTICE_FILE = "office-realtime-notices.json";
const FINAL_DELIVERY_FILE = "office-realtime-final-deliveries.json";

let noticeWriteQueue = Promise.resolve();

export function beginOfficeRealtimeRun({
  scope,
  runId,
  channel,
  chatId,
  sourceMessageId,
  replyInThread = false,
  bridgeHome,
  notifyCompletion = false,
  onEvent = () => {},
}) {
  if (process.env.LARK_OFFICE_RUNTIME !== "1" || typeof scope !== "string" ||
      typeof runId !== "string" || !channel || !chatId || !sourceMessageId) return null;

  const previous = activeRuns.get(scope);
  if (previous) closeRun(previous);

  const run = {
    scope,
    runId,
    startedAt: Date.now(),
    channel,
    chatId,
    sourceMessageId,
    replyInThread,
    bridgeHome,
    notifyCompletion: notifyCompletion === true,
    onEvent,
    lastUpdateLogAt: 0,
    presentation: null,
    closed: false,
    latestProgress: { commentary: ["已接收，正在处理。"], tools: [] },
    latestContent: "",
    lastUpdateAt: 0,
    updateTimer: null,
    heartbeatTimer: null,
    updateTask: null,
  };
  run.latestContent = renderProgress(run);
  activeRuns.set(scope, run);

  reportEvent(run, "starting");
  try {
    run.presentation = new DesktopPresentation({
      channel,
      chatId,
      sourceMessageId,
      replyInThread,
      onMessageId: () => reportEvent(run, "card-open"),
      onError: ({ phase, code, status, apiCode }) => reportEvent(run, "presentation-error", { phase, code, status, apiCode }),
    });
  } catch {
    reportEvent(run, "presentation-error", { code: "constructor-failed" });
    // Keep the delivery context even when the progress card cannot be created.
    return run;
  }

  scheduleContent(run, run.latestContent);
  run.heartbeatTimer = setInterval(() => {
    if (run.closed) return;
    scheduleContent(run, renderProgress(run));
  }, HEARTBEAT_MS);
  run.heartbeatTimer.unref?.();
  return run;
}

export function updateOfficeRealtimeRun(scope, runId, state) {
  const run = activeRuns.get(scope);
  if (!run || run.closed || run.runId !== runId) return;
  try {
    run.latestProgress = projectProgress(state);
    scheduleContent(run, renderProgress(run));
  } catch {
    // Progress projection must never affect the agent stream.
  }
}

export async function finishOfficeRealtimeRun(scope, runId, state) {
  const content = finalContent(state);
  const run = activeRuns.get(scope);
  if (!run) return { kind: "unavailable", messageId: null, fallback: false, content };
  if (run.runId !== runId) return { kind: "stale", messageId: null, fallback: false, content };
  if (run.closed || !run.presentation) {
    if (run.closed) return { kind: "stale", messageId: null, fallback: false, content };
    closeRun(run);
    activeRuns.delete(scope);
    const finalDelivery = await deliverFinalTextOnce(run, content);
    reportEvent(run, "finish", { terminal: state?.terminal ?? "unknown", result: "unavailable", code: finalDelivery });
    return { kind: "unavailable", messageId: null, fallback: false, finalDelivery, content };
  }

  closeRun(run);
  activeRuns.delete(scope);
  const isCompleted = state?.terminal === "done";
  try {
    const result = await run.presentation.finish(content, isCompleted ? "completed" : "paused");
    const messageId = result?.receipt?.messageId ?? result?.messageId ?? run.presentation.messageId ?? null;
    const streamed = result?.kind === "streamed";
    const fallback = !streamed;
    reportEvent(run, "finish", { terminal: state?.terminal ?? "unknown", result: result?.kind ?? "unknown", fallback });
    if (streamed && run.notifyCompletion) await deliverCompletionNotice(run);
    const finalDelivery = streamed ? null : await deliverFinalTextOnce(run, content);
    return {
      kind: result?.kind ?? "uncertain",
      messageId,
      fallback: false,
      finalDelivery,
      content,
    };
  } catch {
    const messageId = run.presentation.messageId ?? null;
    const fallback = true;
    reportEvent(run, "finish", { terminal: state?.terminal ?? "unknown", result: "uncertain", fallback });
    const finalDelivery = await deliverFinalTextOnce(run, content);
    return { kind: "uncertain", messageId, fallback: false, finalDelivery, content };
  }
}

async function deliverCompletionNotice(run) {
  if (!isUuid(run.runId) || typeof run.bridgeHome !== "string" || !isAbsolute(run.bridgeHome) || typeof run.chatId !== "string") return;
  const request = {
    requestId: run.runId,
    completionNoticeEligible: true,
    completionNoticeState: "pending",
  };
  try {
    const result = await sendCompletionNoticeOnce({
      request,
      channel: run.channel,
      chatId: run.chatId,
      persist: () => persistNoticeState(run.bridgeHome, request),
    });
    reportEvent(run, "completion-notice", { result: result.kind, code: result.code });
  } catch {
    // A notice is optional; the terminal status stays in the card.
  }
}

function reportEvent(run, kind, details = {}) {
  try {
    run.onEvent?.({ kind, ...details });
  } catch {
    // Telemetry must not affect progress or result delivery.
  }
}

async function deliverFinalTextOnce(run, content) {
  if (!isUuid(run.runId) || typeof run.bridgeHome !== "string" || !isAbsolute(run.bridgeHome) || !content) {
    reportEvent(run, "final-delivery", { code: "unavailable" });
    return "unavailable";
  }
  const request = { requestId: run.runId, completionNoticeState: "sending",
    completionNoticeUuid: "final-" + run.runId, completionNoticeAttemptedAt: Date.now() };
  try { await persistNoticeState(run.bridgeHome, request, FINAL_DELIVERY_FILE); }
  catch {
    reportEvent(run, "final-delivery", { code: "blocked-before-send" });
    return "blocked-before-send";
  }
  let response;
  try {
    response = await run.channel.rawClient.im.v1.message.reply({
      path: { message_id: run.sourceMessageId },
      data: { msg_type: "text", content: JSON.stringify({ text: content }),
        reply_in_thread: run.replyInThread === true, uuid: request.completionNoticeUuid },
    });
  } catch { response = null; }
  if (response?.code === 0 && typeof response?.data?.message_id === "string") {
    request.completionNoticeState = "sent";
    request.completionNoticeMessageId = response.data.message_id;
    request.completionNoticeSentAt = Date.now();
  } else { request.completionNoticeState = "uncertain"; }
  await persistNoticeState(run.bridgeHome, request, FINAL_DELIVERY_FILE).catch(() => {});
  reportEvent(run, "final-delivery", { code: request.completionNoticeState });
  return request.completionNoticeState;
}

function persistNoticeState(bridgeHome, request, fileName = NOTICE_FILE) {
  const task = noticeWriteQueue.then(
    () => writeNoticeState(bridgeHome, request, fileName),
    () => writeNoticeState(bridgeHome, request, fileName),
  );
  noticeWriteQueue = task.catch(() => {});
  return task;
}

async function writeNoticeState(bridgeHome, request, fileName) {
  const path = join(bridgeHome, fileName);
  const records = await readNoticeState(path);
  const previous = records.find((item) => item.requestId === request.requestId);
  if (request.completionNoticeState === "sending" && previous) throw new Error("notice-already-attempted");
  if (previous?.state === "sent" && request.completionNoticeState !== "sent") throw new Error("notice-terminal-state");
  if (previous?.state === "uncertain" && request.completionNoticeState !== "uncertain") throw new Error("notice-terminal-state");
  const record = {
    requestId: request.requestId,
    uuid: request.completionNoticeUuid ?? null,
    state: request.completionNoticeState,
    messageId: request.completionNoticeMessageId ?? null,
    attemptedAt: Number.isSafeInteger(request.completionNoticeAttemptedAt) ? request.completionNoticeAttemptedAt : null,
    sentAt: Number.isSafeInteger(request.completionNoticeSentAt) ? request.completionNoticeSentAt : null,
  };
  const next = records.filter((item) => item.requestId !== record.requestId);
  next.push(record);
  const retained = next.slice(-MAX_NOTICE_RECORDS);
  const text = JSON.stringify({ version: 1, records: retained }) + "\n";
  if (Buffer.byteLength(text, "utf8") > MAX_NOTICE_BYTES) throw new Error("notice-state-capacity");
  const tempPath = path + "." + process.pid + "." + randomUUID() + ".tmp";
  const handle = await open(tempPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function readNoticeState(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_NOTICE_BYTES) throw new Error("notice-state-unavailable");
    const saved = JSON.parse(await readFile(path, "utf8"));
    if (saved?.version !== 1 || !Array.isArray(saved.records)) throw new Error("notice-state-invalid");
    return saved.records
      .filter((record) => isUuid(record?.requestId) &&
        ["sending", "sent", "uncertain"].includes(record.state))
      .slice(-MAX_NOTICE_RECORDS);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function closeRun(run) {
  if (!run || run.closed) return;
  run.closed = true;
  if (run.heartbeatTimer) clearInterval(run.heartbeatTimer);
  if (run.updateTimer) clearTimeout(run.updateTimer);
  run.heartbeatTimer = null;
  run.updateTimer = null;
}

function projectProgress(state) {
  const blocks = Array.isArray(state?.blocks) ? state.blocks : [];
  const commentary = blocks
    .filter((block) => block?.kind === "text" && typeof block.content === "string")
    .slice(-MAX_COMMENTARY_BLOCKS)
    .map((block) => sanitizePublicText(block.content, 3_000))
    .filter(Boolean);
  const tools = blocks
    .filter((block) => block?.kind === "tool")
    .slice(-MAX_TOOL_BLOCKS)
    .map((block) => ({
      name: safeToolName(block.tool?.name),
      status: safeToolStatus(block.tool?.status),
    }));
  return { commentary, tools };
}

function safeToolName(name) {
  if (typeof name !== "string") return "工具";
  const label = name.replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 40);
  return label || "工具";
}

function safeToolStatus(status) {
  if (status === "running") return "进行中";
  if (status === "done") return "已结束";
  if (status === "error") return "失败";
  return "状态未知";
}

function renderProgress(run) {
  const lines = [];
  for (const block of run.latestProgress.commentary) lines.push(block);
  if (run.latestProgress.tools.length) {
    lines.push("工具状态：");
    for (const tool of run.latestProgress.tools) lines.push("- " + tool.name + "：" + tool.status);
  }
  const seconds = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1_000));
  lines.push("仍在处理，已等待 " + seconds + " 秒。");
  return clip(lines.join("\n\n"), MAX_PROGRESS_CHARS);
}

function finalContent(state) {
  const terminal = state?.terminal;
  if (terminal === "error") return "本次执行未正常结束，请先核对是否已有结果，再安排后续处理。";
  if (terminal === "interrupted") return "本次处理已中断，未能返回完整结果。";
  if (terminal === "idle_timeout") return "本次处理等待超时，已停止。";

  const finalText = typeof state?.finalText === "string" ? state.finalText.trim() : "";
  if (finalText) return sanitizePublicText(finalText, MAX_PROGRESS_CHARS);
  const blocks = Array.isArray(state?.blocks) ? state.blocks : [];
  const text = blocks
    .filter((block) => block?.kind === "text" && typeof block.content === "string")
    .map((block) => block.content)
    .join("\n\n")
    .trim();
  return text
    ? sanitizePublicText(text, MAX_PROGRESS_CHARS)
    : "本次处理已结束，但没有返回内容。";
}

function sanitizePublicText(value, maxChars) {
  return clip(String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [已隐藏]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gi, "[密钥已隐藏]")
    .replace(/\b(api[_-]?key|client[_-]?secret|secret|password|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[已隐藏]")
    .replace(/[A-Z]:[\\/][^\s)\]}>,;]+/gi, "[本地路径]")
    .replace(/file:\/\/\/[^\s)\]}>,;]+/gi, "[本地路径]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/gi, "[邮箱已隐藏]")
    .trim(), maxChars);
}

function clip(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n…";
}

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function scheduleContent(run, content) {
  if (run.closed || !run.presentation) return;
  run.latestContent = content;
  if (run.updateTask || run.updateTimer) return;
  const remaining = Math.max(0, MIN_UPDATE_INTERVAL_MS - (Date.now() - run.lastUpdateAt));
  if (remaining === 0) {
    void flushContent(run);
    return;
  }
  run.updateTimer = setTimeout(() => {
    run.updateTimer = null;
    void flushContent(run);
  }, remaining);
  run.updateTimer.unref?.();
}

async function flushContent(run) {
  if (run.closed || !run.presentation || run.updateTask) return;
  const content = run.latestContent;
  run.lastUpdateAt = Date.now();
  const task = Promise.resolve(run.presentation.update(content)).catch(() => false);
  run.updateTask = task;
  const updated = await task;
  if (updated === true && (!run.lastUpdateLogAt || Date.now() - run.lastUpdateLogAt >= HEARTBEAT_MS)) {
    run.lastUpdateLogAt = Date.now();
    reportEvent(run, "updated");
  }
  if (run.updateTask === task) run.updateTask = null;
  if (!run.closed && run.latestContent !== content) scheduleContent(run, run.latestContent);
}
