import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const verifiedBindings = new WeakSet();
const CHAT_ID_RE = /^oc_[0-9a-f]{32}$/;
const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{8,128}$/;
const APP_ID_RE = /^cli_[A-Za-z0-9_-]{8,128}$/;
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_COMMANDS = new Set(["help", "status", "stop"]);
const HISTORY_COMMANDS = new Set(["resume", "history", "sessions"]);

function assert(condition, category) {
  if (!condition) throw new Error(`supplemental-group-${category}`);
}

function absolutePath(value) {
  assert(typeof value === "string" && value.trim() === value && value.length > 0 && isAbsolute(value), "absolute-path-required");
  return resolve(value);
}

function pathKey(value) { return resolve(value).toLowerCase(); }
function containsPath(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../") && !isAbsolute(rel));
}

function activationTime(value) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  assert(Number.isSafeInteger(ms) && ms > 0 && ms <= Date.now() && new Date(ms).toISOString() === value, "invalid-activation");
  return ms;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

async function readJson(path) {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && info.size <= 4 * 1024 * 1024, "unsafe-json-file");
  const source = await readFile(path);
  assert(source.byteLength <= 4 * 1024 * 1024, "oversized-json-file");
  return JSON.parse(source.toString("utf8").replace(/^\uFEFF/, ""));
}

/** Only this loader can issue supplemental bindings. It does not create files or start runtimes. */
export async function loadSupplementalGroupBindings({ registryPath, botAppId, botOwnerId, reservedGroupIds, reservedThreadIds } = {}) {
  assert(APP_ID_RE.test(botAppId ?? "") && OPEN_ID_RE.test(botOwnerId ?? ""), "bot-identity-required");
  assert(Array.isArray(reservedGroupIds) && reservedGroupIds.length > 0 && reservedGroupIds.every((id) => CHAT_ID_RE.test(id)), "reserved-scopes-required");
  assert(Array.isArray(reservedThreadIds) && reservedThreadIds.length > 0 && reservedThreadIds.every((id) => THREAD_ID_RE.test(id)), "reserved-threads-required");
  const registry = await readJson(absolutePath(registryPath));
  assert(registry?.schemaVersion === 1 && registry.enabled === true && registry.appId === botAppId && registry.ownerOpenId === botOwnerId &&
    Array.isArray(registry.groups) && registry.groups.length > 0, "registry-identity-mismatch");
  assert(Array.isArray(registry.reservedThreadIds) && registry.reservedThreadIds.length > 0 &&
    registry.reservedThreadIds.every((id) => THREAD_ID_RE.test(id)), "registry-reserved-threads-required");
  const groupIds = new Set(reservedGroupIds);
  const threadIds = new Set([...reservedThreadIds, ...registry.reservedThreadIds].map((id) => id.toLowerCase()));
  const groupNames = new Set();
  const occupiedPaths = new Set();
  const occupiedRoots = [];
  const result = [];
  for (const entry of registry.groups) {
    assert(entry && CHAT_ID_RE.test(entry.groupId ?? "") && !groupIds.has(entry.groupId), "scope-reserved-or-duplicate");
    assert(typeof entry.groupName === "string" && entry.groupName.trim() === entry.groupName && entry.groupName.length > 0 && !groupNames.has(entry.groupName), "name-invalid-or-duplicate");
    assert(THREAD_ID_RE.test(entry.threadId ?? "") && !threadIds.has(entry.threadId.toLowerCase()) && THREAD_ID_RE.test(entry.anchorThreadId ?? ""), "thread-reserved-or-invalid");
    assert(entry.appId === botAppId && entry.ownerOpenId === botOwnerId, "entry-identity-mismatch");
    const groupWorkspace = absolutePath(entry.groupWorkspace);
    const dataDir = absolutePath(entry.dataDir);
    assert(!containsPath(groupWorkspace, dataDir) && !containsPath(dataDir, groupWorkspace) &&
      occupiedRoots.every((root) => !containsPath(root, groupWorkspace) && !containsPath(groupWorkspace, root) && !containsPath(root, dataDir) && !containsPath(dataDir, root)), "shared-data-roots");
    const paths = Object.fromEntries(["recorderControlPath", "controlPath", "statePath", "mediaStatePath"].map((key) => [key, absolutePath(entry[key])]));
    const pathKeys = Object.values(paths).map(pathKey);
    assert(new Set(pathKeys).size === pathKeys.length && pathKeys.every((key) => !occupiedPaths.has(key)), "duplicate-control-path");
    assert(Object.values(paths).every((path) => !containsPath(groupWorkspace, path) && !containsPath(dataDir, path)), "control-path-in-content-root");
    const approvedAtMs = activationTime(entry.approvedAt);
    const effectiveFromMs = activationTime(entry.effectiveFrom);
    assert(effectiveFromMs >= approvedAtMs, "activation-order");
    const raw = await readJson(paths.recorderControlPath);
    const trusted = raw?.trustedMemberTasks;
    assert(raw?.schemaVersion === 1 && raw.enabled === true && raw.groupId === entry.groupId && raw.groupName === entry.groupName &&
      raw.ownerOpenId === botOwnerId && raw.botAppId === botAppId && raw.historyIdentity === "user" && raw.requireMention === true &&
      pathKey(absolutePath(raw.groupWorkspace)) === pathKey(groupWorkspace) && pathKey(absolutePath(raw.dataDir)) === pathKey(dataDir), "recorder-control-mismatch");
    assert(raw.groupModel === "gpt-6.1-sol" && raw.groupReasoningEffort === "high" && raw.taskReplyMode === "long_tasks_in_thread", "group-policy-mismatch");
    assert(trusted?.enabled === true && trusted.allowedSenderMode === "all_group_members" && trusted.groupId === entry.groupId && trusted.appId === botAppId &&
      trusted.desktopThreadId === entry.threadId && trusted.approvedAt === entry.approvedAt && trusted.effectiveFrom === entry.effectiveFrom &&
      Array.isArray(trusted.allowedSenderOpenIds) && trusted.allowedSenderOpenIds.length === 0, "trusted-control-mismatch");
    const desktop = await readJson(paths.controlPath);
    assert(desktop?.threadId === entry.threadId && desktop.taskReplyMode === "long_tasks_in_thread" && desktop.notifyCompletion !== true, "desktop-control-mismatch");
    assert(desktop.completionNoticeMode == null || ["off", "mention_requester"].includes(desktop.completionNoticeMode), "completion-notice-mode-invalid");
    const control = {
      trustedMemberTasksEnabled: true,
      trustedMemberOpenIds: [],
      trustedMemberAllowedSenderMode: "all_group_members",
      trustedMemberApprovedAt: entry.approvedAt,
      trustedMemberApprovedAtMs: approvedAtMs,
      trustedMemberEffectiveFrom: entry.effectiveFrom,
      trustedMemberEffectiveFromMs: effectiveFromMs,
      trustedMemberMessageAfterMs: Math.max(approvedAtMs, effectiveFromMs),
      groupId: entry.groupId, groupName: entry.groupName, ownerOpenId: botOwnerId, botAppId,
      groupWorkspace, groupModel: raw.groupModel, groupReasoningEffort: raw.groupReasoningEffort,
      taskReplyMode: "long_tasks_in_thread", respondToOwnerOnly: raw.respondToOwnerOnly !== false,
      memberImagesEnabled: raw.memberImagesEnabled === true, enabled: true,
    };
    const binding = deepFreeze({
      groupId: entry.groupId, groupName: entry.groupName, threadId: entry.threadId, anchorThreadId: entry.anchorThreadId,
      appId: botAppId, ownerOpenId: botOwnerId, groupWorkspace, dataDir,
      ...(entry.nativeTargetWorkspace != null ? { nativeTargetWorkspace: absolutePath(entry.nativeTargetWorkspace) } : {}),
      control, recorderControl: raw, paths,
    });
    verifiedBindings.add(binding);
    result.push(binding);
    groupIds.add(entry.groupId); groupNames.add(entry.groupName); threadIds.add(entry.threadId.toLowerCase());
    for (const key of pathKeys) occupiedPaths.add(key);
    occupiedRoots.push(groupWorkspace, dataDir);
  }
  return Object.freeze(result);
}

export function isVerifiedSupplementalGroupBinding(binding) {
  return binding != null && typeof binding === "object" && verifiedBindings.has(binding);
}

/** The caller separately proves its live channel appId equals binding.appId. */
export function supplementalGroupMessageDisposition(msg, botOwnerId, binding) {
  if (msg?.chatType !== "group") return "not-group";
  if (!isVerifiedSupplementalGroupBinding(binding) || msg.chatId !== binding.groupId) return "ignore-group";
  const control = binding.control;
  if (botOwnerId !== binding.ownerOpenId || control.botAppId !== binding.appId || msg.senderType !== "user" ||
    !OPEN_ID_RE.test(msg.senderId ?? "") || msg.mentionedBot !== true || !Number.isSafeInteger(msg.createTime) ||
    msg.createTime < control.trustedMemberMessageAfterMs || msg.createTime > Date.now()) return "record-only";
  const [first = "", ...args] = typeof msg.content === "string" ? msg.content.trim().split(/\s+/) : [];
  const command = first.startsWith("/") ? first.slice(1).toLowerCase() : "";
  if (command) {
    if (msg.senderId !== binding.ownerOpenId) return "record-only";
    if (HISTORY_COMMANDS.has(command)) return "block-private-history";
    if (command === "stop" && args.length > 0) return "record-only";
    return SAFE_COMMANDS.has(command) ? "safe-command" : "record-only";
  }
  return msg.senderId === binding.ownerOpenId ? "owner-task" : "trusted-member-task";
}
