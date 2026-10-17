import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { loadOfficeAssistantFromProcess } from "./office-policy.mjs";

const MAX_STATE_BYTES = 1024 * 1024;
const MAX_RECORDS = 2000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RPC_TIMEOUT_MS = 30_000;
const MESSAGE_ID = /^om_[A-Za-z0-9_-]{8,128}$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TURN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONFIRM = /^(?:授权了|已授权|已授权了|已经授权|已经授权了|已扫码|已扫码了|已经扫码|扫码了|授权完成|授权完成了|扫码完成|已完成授权|已扫码授权|已扫码授权了)[！!。.]?$/;
const STATUSES = new Set(["sending", "accepted", "uncertain", "deferred"]);
const ERRORS = new Set([null, "office-live-input-uncertain"]);
const RECORD_KEYS = new Set(["sourceMessageId", "runId", "scope", "status", "createdAt", "updatedAt", "turnId", "errorCode"]);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
let queue = Promise.resolve();
// A storage failure must also block an immediate retry in this process.
const blockedSources = new Set();

function failClosed() {
  const error = new Error("office-live-input-persist");
  error.code = "office-live-input-persist";
  error.consumed = true;
  return error;
}

async function normalPath(path, { directory = false, maxBytes = MAX_STATE_BYTES } = {}) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      (!directory && info.size > maxBytes) || !samePath(await realpath(path), path)) throw failClosed();
}

async function optionalJson(path, maxBytes = MAX_STATE_BYTES) {
  try {
    await normalPath(path, { maxBytes });
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > maxBytes) throw failClosed();
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw failClosed();
  }
}

async function atomicState(path, state) {
  const raw = JSON.stringify(state);
  if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) throw failClosed();
  // Validate an existing destination again before replacing it.
  try { await normalPath(path); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(raw, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await normalPath(path);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function validateState(state, assistant) {
  if (!isRecord(state) || state.schemaVersion !== 1 || state.appId !== assistant.appId ||
      !isRecord(state.sources) || Object.keys(state.sources).length > MAX_RECORDS) throw failClosed();
  for (const [sourceMessageId, entry] of Object.entries(state.sources)) {
    if (!MESSAGE_ID.test(sourceMessageId) || !isRecord(entry) || entry.sourceMessageId !== sourceMessageId ||
        !UUID.test(entry.runId ?? "") || !CHAT_ID.test(entry.scope ?? "") || !STATUSES.has(entry.status) ||
        typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt)) ||
        typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt)) ||
        (entry.turnId !== undefined && !TURN_ID.test(entry.turnId)) || !ERRORS.has(entry.errorCode) ||
        Object.keys(entry).some((key) => !RECORD_KEYS.has(key))) throw failClosed();
  }
}

function pruneConfirmed(state) {
  const cutoff = Date.now() - MAX_AGE_MS;
  const confirmed = Object.entries(state.sources)
    .filter(([, entry]) => entry.status === "accepted" || entry.status === "deferred")
    .sort((a, b) => Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt));
  let count = Object.keys(state.sources).length;
  for (const [id, entry] of confirmed) {
    if (Date.parse(entry.updatedAt) < cutoff || count >= MAX_RECORDS) {
      delete state.sources[id];
      count -= 1;
    }
  }
  // Unresolved submissions are never pruned or retried automatically.
  if (count >= MAX_RECORDS) throw failClosed();
}

async function pendingOAuthConfirmation(assistant, msg) {
  if (typeof msg.content !== "string" || !CONFIRM.test(msg.content.trim())) return false;
  const pending = await optionalJson(join(assistant.bridgeHome, ".office-user-oauth.json"), 64 * 1024);
  if (pending === null) return false;
  // Only inspect flow metadata; no nonce is accessed, logged or forwarded.
  if (!isRecord(pending) || pending.schemaVersion !== 1 || typeof pending.status !== "string") throw failClosed();
  return pending.status !== "completed";
}

async function claimSource(path, entry) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ schemaVersion: 1, ...entry }), "utf8");
    await handle.sync();
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      await normalPath(path, { maxBytes: 2048 });
      return false;
    }
    throw failClosed();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function steerWithDeadline(run, input) {
  let timer;
  try {
    // The race does not cancel the RPC: timeout means acceptance is uncertain.
    return await Promise.race([
      Promise.resolve().then(() => run.steer(input)),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ status: "uncertain" }), RPC_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    return { status: "uncertain" };
  } finally {
    clearTimeout(timer);
  }
}

async function submit({ assistant, run, runId, msg, scope, prompt, images }) {
  const sourceKey = `${assistant.appId}:${msg.messageId}`;
  if (blockedSources.has(sourceKey)) return true;
  const statePath = join(assistant.bridgeHome, ".office-live-input-state.json");
  const lockPath = join(assistant.bridgeHome, ".office-live-input-state.lock");
  const claimDirectory = join(assistant.bridgeHome, ".office-live-input-claims");
  let lock;
  try {
    await normalPath(assistant.bridgeHome, { directory: true });
    if (await pendingOAuthConfirmation(assistant, msg)) return false;
    // A crash leaves the lock in place. Never infer non-acceptance from age.
    lock = await open(lockPath, "wx", 0o600);
    await normalPath(lockPath, { maxBytes: 0 });
    try { await mkdir(claimDirectory, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    await normalPath(claimDirectory, { directory: true });
    const now = new Date().toISOString();
    const entry = { sourceMessageId: msg.messageId, runId, scope,
      status: "sending", createdAt: now, updatedAt: now, errorCode: null };
    const claimName = createHash("sha256").update(sourceKey).digest("hex");
    // Permanent exclusive claims survive state pruning and partial writes.
    if (!await claimSource(join(claimDirectory, `${claimName}.json`), entry)) return true;
    const state = await optionalJson(statePath) ?? { schemaVersion: 1, appId: assistant.appId, sources: {} };
    validateState(state, assistant);
    if (Object.hasOwn(state.sources, msg.messageId)) return true;
    pruneConfirmed(state);
    state.sources[msg.messageId] = entry;
    await atomicState(statePath, state);
    const result = await steerWithDeadline(run, { prompt, sourceMessageIds: [msg.messageId], images });
    let status;
    let turnId;
    try { status = result?.status; turnId = result?.turnId; }
    catch { status = "uncertain"; }
    entry.updatedAt = new Date().toISOString();
    if (status === "accepted") {
      entry.status = "accepted";
      if (typeof turnId === "string" && TURN_ID.test(turnId)) entry.turnId = turnId;
    } else if (status === "not-active") {
      // This is the sole adapter result guaranteeing this input was not accepted.
      entry.status = "deferred";
    } else {
      entry.status = "uncertain";
      entry.errorCode = "office-live-input-uncertain";
    }
    await atomicState(statePath, state);
    return entry.status !== "deferred";
  } catch {
    blockedSources.add(sourceKey);
    throw failClosed();
  } finally {
    if (lock) {
      await lock.close().catch(() => {});
      // Failure to remove a lock is fail closed on the next attempt.
      await unlink(lockPath).catch(() => {});
    }
  }
}

/**
 * true: consumed, including duplicate and uncertain submissions.
 * false: not eligible, or explicitly not accepted and handed to pending once.
 * A thrown fixed error has consumed=true; callers must not fall through to pending.
 * logger is accepted for intake compatibility; no caller content is logged here.
 */
export async function tryOfficeLiveInput({ run, msg, scope, prompt, images, logger } = {}) {
  let assistant;
  try { assistant = loadOfficeAssistantFromProcess({ requireReady: true }); }
  catch { return false; }
  if (assistant.liveInputEnabled !== true || !run || typeof run.steer !== "function" ||
      typeof run.runId !== "string" || !UUID.test(run.runId) || !msg ||
      msg.chatType !== "p2p" || msg.senderId !== assistant.allowedOpenId ||
      msg.senderIsBot === true || (msg.senderType !== undefined && msg.senderType !== "user") ||
      typeof msg.messageId !== "string" || !MESSAGE_ID.test(msg.messageId) ||
      typeof msg.chatId !== "string" || !CHAT_ID.test(msg.chatId) || scope !== msg.chatId ||
      msg.threadId || msg.topicId || msg.chatMode === "topic" ||
      typeof prompt !== "string" || prompt.length > 64 * 1024 || Buffer.byteLength(prompt, "utf8") > 256 * 1024 ||
      (images !== undefined && (!Array.isArray(images) || images.length > 8 ||
        !images.every((path) => typeof path === "string" && path.length <= 4096 && isAbsolute(path) && !path.includes("\0"))))) return false;
  const input = { assistant, run, runId: run.runId,
    msg: { messageId: msg.messageId, content: msg.content }, scope, prompt,
    images: images === undefined ? undefined : [...images] };
  const operation = queue.then(() => submit(input));
  queue = operation.catch(() => {});
  return operation;
}
