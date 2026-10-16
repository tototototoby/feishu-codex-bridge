import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const RECORD_LIMIT = 64 * 1024;
const MESSAGE_ID = /^om_[A-Za-z0-9_-]{8,128}$/;
const SCOPE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const APPROVED_SCOPES = new Set(["minutes:minutes.basic:read", "minutes:minutes.upload:write"]);
const CONFIRM = /^(?:授权了|已授权|已授权了|已经授权|已经授权了|已扫码|已扫码了|已经扫码|扫码了|授权完成|授权完成了|扫码完成|已完成授权|已扫码授权|已扫码授权了)[！!。.]?$/;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

async function normalFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > RECORD_LIMIT || !samePath(await realpath(path), path)) throw new Error("oauth-file");
}

async function readFlow(path) {
  try {
    await normalFile(path);
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw) > RECORD_LIMIT) throw new Error("oauth-file");
    return { raw, flow: JSON.parse(raw) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function validateFlow(flow, context, fail) {
  if (!record(flow) || flow.schemaVersion !== 1 ||
      !["awaiting-user", "completion-started", "completed", "uncertain", "failed"].includes(flow.status) ||
      flow.appId !== context.identity.appId || flow.ownerOpenId !== context.identity.openId ||
      typeof flow.chatId !== "string" || !/^oc_[A-Za-z0-9_-]{8,128}$/.test(flow.chatId) ||
      !Array.isArray(flow.scopes) || flow.scopes.length < 1 || flow.scopes.length > 16 ||
      !flow.scopes.every((scope) => typeof scope === "string" && SCOPE.test(scope)) ||
      new Set(flow.scopes).size !== flow.scopes.length ||
      flow.scopes.length !== APPROVED_SCOPES.size || !flow.scopes.every((scope) => APPROVED_SCOPES.has(scope)) ||
      typeof flow.createdAt !== "string" || !Number.isFinite(Date.parse(flow.createdAt)) ||
      typeof flow.expiresAt !== "string" || !Number.isFinite(Date.parse(flow.expiresAt)) ||
      Date.parse(flow.expiresAt) <= Date.parse(flow.createdAt) || Date.parse(flow.createdAt) > Date.now() + 30_000 ||
      (flow.status === "completed" && Object.hasOwn(flow, "deviceCode")) ||
      (flow.status === "awaiting-user" && (typeof flow.deviceCode !== "string" ||
        flow.deviceCode.length < 8 || flow.deviceCode.length > 4096 || !/^[\x21-\x7e]+$/.test(flow.deviceCode)))) throw fail("oauth-config");
}

async function claimCompletion(context, flow, fail) {
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const nonceSha256 = digest(flow.deviceCode);
  const bindingSha256 = digest(JSON.stringify([flow.appId, flow.ownerOpenId, flow.createdAt, nonceSha256]));
  // Key on app/owner/nonce so even changing createdAt cannot replay a nonce.
  // Never remove this exclusive claim, including partial writes or crashes.
  const claimKey = digest(JSON.stringify([flow.appId, flow.ownerOpenId, nonceSha256]));
  const path = join(context.assistant.bridgeHome, `.office-user-oauth-claim-${claimKey}.json`);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ schemaVersion: 1, bindingSha256, nonceSha256,
      createdAt: flow.createdAt, claimedAt: new Date().toISOString(), status: "completion-claimed" }), "utf8");
    await handle.sync();
  } catch { throw fail("oauth-recovery-required"); }
  finally { await handle?.close().catch(() => {}); }
}

async function persistFlow(context, path, expected, flow) {
  const current = await readFlow(path);
  if (!current || current.raw !== expected.raw) throw new Error("oauth-flow-changed");
  await atomicJson(path, flow);
  return { raw: JSON.stringify(flow), flow };
}

async function publishStatus(context, flow, errorCode = null) {
  const directory = join(context.assistant.workspace, "work");
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)) throw new Error("oauth-status-path");
  const path = join(directory, "office-user-auth-status.json");
  try { await normalFile(path); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  await atomicJson(path, { schemaVersion: 1, status: flow.status, scopes: flow.scopes,
    updatedAt: new Date().toISOString(), errorCode });
}

export async function completeOfficePendingOAuth(context, signal, opts, { runCli, fail, verifyCredentials, verifyBeforeCompletion }) {
  const path = join(context.assistant.bridgeHome, ".office-user-oauth.json");
  let pending;
  try { pending = await readFlow(path); }
  catch { throw fail("oauth-config"); }
  if (!pending) return null;
  validateFlow(pending.flow, context, fail);
  const flow = pending.flow;
  if (flow.status === "completed") {
    const expiresAt = await verifyCredentials(context, signal, flow.scopes);
    try { await publishStatus(context, flow); }
    catch { throw fail("oauth-status"); }
    return expiresAt;
  }
  const ids = opts?.officeSourceMessageIds;
  if (ids === undefined || (Array.isArray(ids) && ids.length === 0)) return null;
  if (!Array.isArray(ids) || ids.length > 50 || !ids.every((id) => typeof id === "string" && MESSAGE_ID.test(id)) ||
      new Set(ids).size !== ids.length) throw fail("oauth-source");
  const response = await runCli(context, ["im", "+messages-mget", "--message-ids", ids.join(","), "--as", "bot", "--no-reactions", "--json"], signal);
  if (!record(response) || response.ok !== true || response.identity !== "bot" || !record(response.data) ||
      !Array.isArray(response.data.messages)) throw fail("oauth-source");
  // Examine only the exact current sources. Replies, quoted messages, rendered
  // prompts and thread expansions never count as authorization confirmation.
  const candidates = response.data.messages.filter((source) => {
    if (!record(source) || !ids.includes(source.message_id) || source.chat_id !== flow.chatId || source.deleted ||
        source.msg_type !== "text" || source.sender?.sender_type !== "user" || source.sender?.id_type !== "open_id" ||
        source.sender.id !== context.identity.openId || source.sender.tenant_key !== context.identity.tenantKey ||
        typeof source.content !== "string" || !CONFIRM.test(source.content.trim())) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  // The shortcut formats create_time to local minutes. Fetch the exact source
  // through the fixed raw read API for millisecond time and unquoted text.
  let confirmation = false;
  for (const candidate of candidates) {
    const original = await runCli(context, ["api", "GET", `/open-apis/im/v1/messages/${candidate.message_id}`,
      "--as", "bot", "--params", '{"user_id_type":"open_id"}', "--json"], signal);
    if (!record(original) || original.ok !== true || original.identity !== "bot" || !record(original.data) ||
        !Array.isArray(original.data.items)) throw fail("oauth-source");
    const originals = original.data.items.filter((source) => source?.message_id === candidate.message_id);
    if (originals.length !== 1) throw fail("oauth-source");
    const source = originals[0];
    let body;
    try { body = JSON.parse(source.body?.content); } catch { throw fail("oauth-source"); }
    if (source.deleted || source.msg_type !== "text" || source.chat_id !== flow.chatId ||
        source.sender?.sender_type !== "user" || source.sender?.id_type !== "open_id" ||
        source.sender.id !== context.identity.openId || source.sender.tenant_key !== context.identity.tenantKey ||
        typeof body?.text !== "string" || !CONFIRM.test(body.text.trim()) ||
        typeof source.create_time !== "string" || !/^\d{13}$/.test(source.create_time)) continue;
    const created = Number(source.create_time);
    if (created < Date.parse(flow.createdAt) || created > Date.now() + 30_000 || created > Date.parse(flow.expiresAt)) continue;
    confirmation = true;
    break;
  }
  if (!confirmation) return null;
  if (flow.status !== "awaiting-user") throw fail("oauth-recovery-required");
  if (Date.parse(flow.expiresAt) <= Date.now()) {
    const expired = { ...flow, status: "failed", updatedAt: new Date().toISOString(), errorCode: "office-user-auth-oauth-expired" };
    try {
      await persistFlow(context, path, pending, expired);
      await publishStatus(context, expired, expired.errorCode);
    } catch { throw fail("oauth-persist"); }
    throw fail("oauth-expired");
  }
  await verifyBeforeCompletion();
  if (signal.aborted) throw fail("stopped");
  await claimCompletion(context, flow, fail);
  const started = { ...flow, status: "completion-started", completionStartedAt: new Date().toISOString() };
  try { pending = await persistFlow(context, path, pending, started); }
  catch { throw fail("oauth-persist"); }
  let expiresAt;
  let completed;
  try {
    // This is the only OAuth mutation. Never begin a new flow, add scopes,
    // expose the nonce, or replay this command after any uncertain outcome.
    const completion = await runCli(context, ["auth", "login", "--device-code", flow.deviceCode, "--json"], signal, { parseJson: false });
    if (completion?.completedExitZero !== true) throw fail("oauth-completion");
    expiresAt = await verifyCredentials(context, signal, flow.scopes);
    completed = { ...started, status: "completed", completedAt: new Date().toISOString(), errorCode: null };
    delete completed.deviceCode;
    pending = await persistFlow(context, path, pending, completed);
  } catch {
    const failed = { ...pending.flow, status: "uncertain", updatedAt: new Date().toISOString(), errorCode: "office-user-auth-oauth-uncertain" };
    // A persisted started/uncertain marker blocks nonce replay even if status
    // publication or this final write itself fails.
    try { pending = await persistFlow(context, path, pending, failed); } catch {}
    await publishStatus(context, failed, failed.errorCode).catch(() => {});
    throw fail("oauth-uncertain");
  }
  // A presentation failure must not change the persisted OAuth outcome.
  try { await publishStatus(context, completed); }
  catch { throw fail("oauth-status"); }
  return expiresAt;
}
