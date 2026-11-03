import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 80 * 1024;
const MAX_DIRECTORY_ENTRIES = 100_000;
const MAX_REQUESTS = 64;
const MAX_ITEMS_PER_REQUEST = 128;
const cache = new Map();

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function time(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function within(root, path) {
  const tail = relative(root, path);
  return tail === "" || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`));
}

// Check every ancestor as well as the selected file. Do not follow a junction
// supplied as CODEX_HOME, a date directory, or the rollout itself.
async function checkedPath(path, directory) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  let stat;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    stat = await lstat(current);
    if (stat.isSymbolicLink()) throw failure("rollout-unsafe-path");
    if (current !== absolute && !stat.isDirectory()) throw failure("rollout-unsafe-path");
  }
  stat ??= await lstat(absolute);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw failure("rollout-unsafe-path");
  const canonical = await realpath(absolute);
  if (relative(absolute, canonical) !== "") throw failure("rollout-unsafe-path");
  return { path: absolute, stat };
}

async function locate(sessions, threadId) {
  let entries = 0;
  let found = null;
  async function visit(directory, depth) {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (++entries > MAX_DIRECTORY_ENTRIES) throw failure("rollout-directory-budget-exceeded");
      const name = entry.name;
      const path = join(directory, name);
      if (!within(sessions, path)) throw failure("rollout-unsafe-path");
      if (depth < 3) {
        const valid = depth === 0 ? /^\d{4}$/.test(name)
          : depth === 1 ? /^(?:0[1-9]|1[0-2])$/.test(name)
            : /^(?:0[1-9]|[12]\d|3[01])$/.test(name);
        if (!valid) continue;
        if (entry.isSymbolicLink()) throw failure("rollout-unsafe-path");
        if (!entry.isDirectory()) continue;
        await checkedPath(path, true);
        await visit(path, depth + 1);
      } else if (name.startsWith("rollout-") && name.endsWith(`-${threadId}.jsonl`)) {
        if (entry.isSymbolicLink()) throw failure("rollout-unsafe-path");
        await checkedPath(path, false);
        if (found) throw failure("rollout-ambiguous-file");
        found = path;
      }
    }
  }
  await visit(sessions, 0);
  return found;
}

// Only standalone, unquoted protocol blocks are exported. Nested/crossed
// markers, code examples and incomplete blocks cannot become public replies.
function envelopes(text, requests, timestamp) {
  const result = [];
  let fence = null;
  let block = null;
  const htmlContainers = [];
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length &&
          /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = null;
      if (block?.kind === "reply") block.lines.push(line);
      else if (block) block.invalid = true;
      continue;
    }
    if (fence) {
      if (block?.kind === "reply") block.lines.push(line);
      continue;
    }
    // HTML containers outside a reply are reference text, just like Markdown
    // code and blockquotes. Inside a reply, preserve the original body.
    if (!block) {
      const tags = [...line.matchAll(/<(\/?)(pre|code|blockquote)\b[^>]*>/gi)];
      const insideHtml = htmlContainers.length > 0;
      for (const tag of tags) {
        const name = tag[2].toLowerCase();
        if (!tag[1]) htmlContainers.push(name);
        else if (htmlContainers.pop() !== name) return [];
      }
      if (insideHtml || tags.length || htmlContainers.length) continue;
    } else if (block.kind === "progress" && /<\/?(?:pre|code|blockquote)\b/i.test(line)) block.invalid = true;
    if (/^(?: {4}|\t| {0,3}>)/.test(line)) {
      if (block?.kind === "reply") block.lines.push(line);
      else if (block) block.invalid = true;
      continue;
    }
    const marker = line.trim().match(/^<!-- feishu-(reply|progress):([0-9a-f-]+):(start|end) -->$/);
    if (marker) {
      if (marker[3] === "start") {
        if (block) { block.depth++; block.invalid = true; }
        else block = { kind: marker[1], requestId: marker[2], depth: 1, invalid: false, lines: [line] };
      } else if (block) {
        if (block.depth > 1) { block.depth--; block.invalid = true; continue; }
        const request = requests.get(block.requestId);
        if (!block.invalid && marker[1] === block.kind && marker[2] === block.requestId &&
            request && timestamp >= request.createdAt && block.lines.slice(1).join("").trim()) {
          result.push({ requestId: block.requestId, text: [...block.lines, line].join("").trimEnd() });
        }
        block = null;
      }
      continue;
    }
    if (/<!--\s*feishu-(?:reply|progress):/.test(line)) {
      if (block) block.invalid = true;
      continue;
    }
    if (block) block.lines.push(line);
  }
  return result;
}

function acceptLine(state, bytes, position, threadId, requests) {
  let record;
  try { record = JSON.parse(bytes.toString("utf8")); } catch {
    if (!state.confirmed) throw failure("rollout-session-meta-missing");
    return;
  }
  if (!state.confirmed && record?.type !== "session_meta") throw failure("rollout-session-meta-missing");
  if (record?.type === "session_meta") {
    if (state.confirmed) throw failure("rollout-session-meta-misplaced");
    if (record.payload?.id !== threadId) throw failure("rollout-session-id-mismatch");
    if (record.payload?.originator !== "Codex Desktop") throw failure("rollout-session-originator-mismatch");
    state.confirmed = true;
    return;
  }
  if (!state.confirmed) return;
  if (record?.type === "turn_context") {
    const startedAt = time(record.timestamp);
    state.turnId = typeof record.payload?.turn_id === "string" && UUID.test(record.payload.turn_id) && Number.isFinite(startedAt)
      ? record.payload.turn_id : null;
    state.startedAt = Number.isFinite(startedAt) ? startedAt / 1_000 : null;
    return;
  }
  const payload = record?.payload;
  if (!state.turnId || record?.type !== "response_item" || payload?.type !== "message" ||
      payload.role !== "assistant" || !["final_answer", "commentary"].includes(payload.phase) ||
      !Array.isArray(payload.content)) return;
  const timestamp = time(record.timestamp);
  if (!Number.isFinite(timestamp)) return;
  const text = payload.content.filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
  if (!text.includes("<!-- feishu-")) return;
  const matched = new Map();
  for (const envelope of envelopes(text, requests, timestamp)) {
    const previous = matched.get(envelope.requestId);
    matched.set(envelope.requestId, previous ? `${previous}\n\n${envelope.text}` : envelope.text);
  }
  for (const [requestId, markedText] of matched) {
    const item = {
      turnId: state.turnId,
      startedAt: state.startedAt,
      item: { type: "agentMessage", phase: payload.phase, text: markedText,
        id: `rollout:${threadId}:${position}:${requestId}` },
    };
    // Include IDs, phase and turn metadata in the per-request output budget.
    item.bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (item.bytes > MAX_REQUEST_BYTES) throw failure("rollout-result-budget-exceeded");
    const items = state.matches.get(requestId) ?? [];
    items.push(item);
    let total = items.reduce((sum, entry) => sum + entry.bytes, 0);
    while (total > MAX_REQUEST_BYTES || items.length > MAX_ITEMS_PER_REQUEST) total -= items.shift().bytes;
    state.matches.set(requestId, items);
  }
}

async function scan(handle, state, size, threadId, requests) {
  // One invocation is bounded; a large cold rollout is resumed on later calls.
  const endPosition = Math.min(size, state.offset + MAX_SCAN_BYTES);
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = state.offset;
  let lineStart = position;
  let pieces = [];
  let length = 0;
  let dropping = state.skippingLongLine;
  while (position < endPosition) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, endPosition - position), position);
    if (!bytesRead) throw failure("rollout-file-changed");
    let start = 0;
    while (start < bytesRead) {
      const newline = chunk.indexOf(10, start);
      const complete = newline >= 0 && newline < bytesRead;
      const end = complete ? newline : bytesRead;
      if (!dropping) {
        length += end - start;
        if (length > MAX_LINE_BYTES) {
          if (!state.confirmed) throw failure("rollout-session-meta-missing");
          dropping = true;
          pieces = [];
        }
        else pieces.push(Buffer.from(chunk.subarray(start, end)));
      }
      if (complete) {
        if (!dropping && length) acceptLine(state, Buffer.concat(pieces, length), lineStart, threadId, requests);
        lineStart = position + end + 1;
        pieces = [];
        length = 0;
        dropping = false;
      }
      start = end + (complete ? 1 : 0);
    }
    position += bytesRead;
  }
  // Ordinary partial JSON is reread next time without caching its contents.
  // Oversized partial lines can be discarded incrementally until their newline.
  state.offset = dropping ? endPosition : lineStart;
  state.skippingLongLine = dropping;
  return endPosition === size;
}

/** Read only exact pending-request marker envelopes from one local rollout. */
export async function readRolloutMarkers({ threadId, requests, codexHome } = {}) {
  if (typeof threadId !== "string" || !UUID.test(threadId) || !Array.isArray(requests)) return null;
  const eligible = new Map();
  for (const request of requests) {
    if (!["accepted", "delivery_uncertain"].includes(request?.status)) continue;
    if (typeof request.requestId !== "string" || !UUID.test(request.requestId) ||
        !Number.isFinite(time(request.createdAt))) continue;
    const normalized = { requestId: request.requestId, createdAt: time(request.createdAt) };
    if (eligible.has(normalized.requestId) && eligible.get(normalized.requestId).createdAt !== normalized.createdAt)
      throw failure("rollout-ambiguous-request");
    eligible.set(normalized.requestId, normalized);
  }
  if (!eligible.size) return null;
  if (eligible.size > MAX_REQUESTS) throw failure("rollout-request-budget-exceeded");
  const configuredHome = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  if (typeof configuredHome !== "string" || !isAbsolute(configuredHome) || /^[\\/]{2}/.test(configuredHome))
    throw failure("rollout-unsafe-path");
  const sessions = resolve(configuredHome, "sessions");
  const key = `${sessions}\0${threadId}`;
  const signature = JSON.stringify([...eligible.values()].sort((a, b) => a.requestId.localeCompare(b.requestId)));
  let handle;
  try {
    await checkedPath(sessions, true);
    const previous = cache.get(key);
    const path = previous?.path ?? await locate(sessions, threadId);
    if (!path) return null;
    if (!within(sessions, path)) throw failure("rollout-unsafe-path");
    const checked = await checkedPath(path, false);
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== checked.stat.dev || stat.ino !== checked.stat.ino)
      throw failure("rollout-file-changed");
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const reusable = previous?.identity === identity && previous.signature === signature &&
      stat.size >= previous.size && (stat.size !== previous.size || stat.mtimeMs === previous.mtimeMs);
    const state = reusable ? {
      ...previous,
      matches: new Map([...previous.matches].map(([id, items]) => [id, [...items]])),
    } : { path, identity, signature, offset: 0, skippingLongLine: false, confirmed: false,
      turnId: null, startedAt: null, matches: new Map() };
    const caughtUp = await scan(handle, state, stat.size, threadId, eligible);
    const after = await handle.stat();
    if (after.size < stat.size || after.ino !== stat.ino || after.dev !== stat.dev ||
        (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) throw failure("rollout-file-changed");
    const finalPath = await checkedPath(path, false);
    if (finalPath.stat.dev !== stat.dev || finalPath.stat.ino !== stat.ino) throw failure("rollout-file-changed");
    if (finalPath.stat.size < stat.size ||
        (finalPath.stat.size === stat.size && finalPath.stat.mtimeMs !== stat.mtimeMs)) throw failure("rollout-file-changed");
    state.size = stat.size;
    state.mtimeMs = stat.mtimeMs;
    cache.delete(key);
    if (!state.confirmed) return null;
    cache.set(key, state);
    while (cache.size > 4) cache.delete(cache.keys().next().value);
    // Never expose an earlier match before the remaining snapshot (or an append
    // observed during this scan) has been checked for a newer closure.
    if (!caughtUp || state.offset !== stat.size || state.skippingLongLine ||
        after.size !== stat.size || finalPath.stat.size !== stat.size) return null;
    const turns = new Map();
    const items = [...state.matches.values()].flat().sort((a, b) => {
      const position = (entry) => Number(entry.item.id.split(":")[2]);
      return position(a) - position(b);
    });
    for (const entry of items) {
      if (!turns.has(entry.turnId)) turns.set(entry.turnId, { id: entry.turnId, startedAt: entry.startedAt, items: [] });
      turns.get(entry.turnId).items.push({ ...entry.item });
    }
    return turns.size ? { thread: { id: threadId }, turns: [...turns.values()] } : null;
  } catch (error) {
    cache.delete(key);
    if (error?.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
