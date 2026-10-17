import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, join, resolve } from "node:path";
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";

const MODEL = "gpt-6.1-sol";
const RPC_MS = 20_000;
const STARTUP_MS = 65_000;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_STEER_BATCHES = 512;
const MAX_STEER_QUEUE = 32;
const MAX_INPUT_BYTES = 1024 * 1024;
const TOOL_OUTPUT_CHARS = 128 * 1024;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const textValue = (value) => typeof value === "string" ? value : "";
const tokenValue = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * One stdio app-server process, one thread, one turn. The caller owns identity,
 * home/env construction and the opt-in boundary; no auth or retry is performed here.
 * steer() never starts another turn and never retries a request of unknown outcome.
 */
export function createOfficeLiveRun(opts, { binary, env, prompt = opts.prompt, logger } = {}) {
  if (!opts?.cwd || typeof binary !== "string" || !binary || !isObject(env)) {
    throw new Error("office live run requires a fixed binary, cwd and environment");
  }
  if (opts.liveInputEnabled !== true) throw new Error("office live run requires explicit live input opt-in");
  if (opts.model !== undefined && opts.model !== MODEL) throw new Error("office live run model must be gpt-6.1-sol");
  const sandbox = opts.sandbox ?? "workspace-write";
  if (sandbox !== "workspace-write" && sandbox !== "read-only") throw new Error("office live run sandbox is unsupported");
  if (opts.threadId !== undefined && (typeof opts.threadId !== "string" || !opts.threadId)) {
    throw new Error("office live run thread id is invalid");
  }
  const initialInput = makeInput(prompt, opts.images);
  const initialMessageIds = Array.isArray(opts.officeSourceMessageIds) ? opts.officeSourceMessageIds.slice(0, 64) : [];
  const runId = opts.runId ?? randomUUID();
  if (typeof runId !== "string" || !runId || runId.length > 256) throw new Error("office live run id is invalid");
  // Claim is durable before a writer can exist. Existing claims are never
  // reclaimed here, including stale-looking claims left by a bridge crash.
  const writerLease = claimWriterLease(env.CODEX_HOME, runId);
  let child;
  try {
    child = spawn(binary, [
      "-c", 'model_reasoning_effort="high"',
      "-c", 'approval_policy="never"',
      "-c", 'shell_environment_policy.inherit="all"',
      "app-server", "--listen", "stdio://",
    ], { cwd: opts.cwd, env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    // Node's argument validation rejects before process creation. Unknown
    // synchronous errors do not prove that no writer exists, so retain the claim.
    const noChildCreated = child === undefined && ["ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_OUT_OF_RANGE"].includes(error?.code);
    if (!noChildCreated) throw new Error("office live run spawn outcome is unconfirmed; writer lease retained");
    try { writerLease.release(); } catch { throw new Error("office live run spawn failed and writer lease cleanup failed"); }
    throw new Error("office live run process failed to start");
  }
  const queue = [];
  const consumers = [];
  const pending = new Map();
  const items = new Map();
  const submissions = new Map();
  const messageBatches = new Map();
  // The original turn input is already submitted by turn/start. An upstream
  // duplicate event must not append that same trigger to its own active turn.
  for (const id of initialMessageIds) {
    if (typeof id === "string" && id.length <= 256) messageBatches.set(id, "initial-input");
  }
  let queueBytes = 0;
  let textBytes = 0;
  let nextRpcId = 1;
  let threadId = opts.threadId;
  let activeTurnId;
  let startingTurn = false;
  let completedTurnId;
  let terminal = false;
  let terminalReason;
  let terminalError;
  let stopped = false;
  let closing = false;
  let exited = false;
  let leaseReleased = false;
  let streamClosed = false;
  let exitInfo;
  let shutdownPromise;
  let stopPromise;
  let startupTimer;
  let stderrBytes = 0;
  let lastFinalText;
  let usage;
  let steerTail = Promise.resolve();
  let steerQueued = 0;
  let stdoutBuffer = "";
  let protocolBroken = false;
  const decoder = new StringDecoder("utf8");
  let resolveExit;
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });

  function log(event, fields = {}) {
    // Only adapter-owned metadata enters logs; never RPC bodies, stderr or errors.
    try {
      const metadata = { runId, threadId, turnId: activeTurnId ?? completedTurnId, ...fields };
      if (typeof logger === "function") logger(event, metadata);
      else logger?.info?.("office-live-run", event, metadata);
    } catch { /* Diagnostics must not alter request delivery. */ }
  }

  function enqueue(event, emergency = false) {
    if (streamClosed) return false;
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (!emergency && (queue.length >= 4096 || queueBytes + bytes > MAX_QUEUE_BYTES)) {
      fail("office live run event buffer limit exceeded");
      return false;
    }
    if (consumers.length) consumers.shift()({ value: event, done: false });
    else { queue.push({ event, bytes }); queueBytes += bytes; }
    return true;
  }

  function closeStream() {
    streamClosed = true;
    while (consumers.length) consumers.shift()({ value: undefined, done: true });
  }

  function finish(reason) {
    if (terminal) return;
    terminal = true;
    terminalReason = reason;
    clearTimeout(startupTimer);
    activeTurnId = undefined;
    if (!exited) void shutdown().catch(() => { log("shutdown-failed-lease-retained"); });
  }

  function completeStream(reason, errorMessage) {
    if (streamClosed) return;
    // Normal completion is visible only after close and successful lease release.
    // A failed shutdown may close the stream, but keeps the durable claim and
    // emits a failure so a later writer cannot mistake it for successful exit.
    if (errorMessage) enqueue({ type: "error", message: errorMessage, terminationReason: "failed" }, true);
    if (lastFinalText !== undefined) enqueue({ type: "final_text", content: lastFinalText }, true);
    if (usage) enqueue({ type: "usage", ...usage }, true);
    enqueue({ type: "done", threadId, terminationReason: reason }, true);
    closeStream();
  }

  function fail(message) {
    if (terminal) return;
    // Error messages are fixed strings from this module, never provider content.
    terminalError = message;
    finish("failed");
  }

  function write(message) {
    if (exited || closing || child.stdin.destroyed || child.stdin.writableEnded) return false;
    const encoded = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(encoded, "utf8") > MAX_LINE_BYTES) return false;
    // Backpressure is bounded: at most a handful of RPCs and a serial steer can
    // be pending. A successful write is evidence of submission, not acceptance.
    try { child.stdin.write(encoded); return true; } catch { return false; }
  }

  function rpc(method, params, timeoutMs = RPC_MS) {
    const id = nextRpcId++;
    let sent = false;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject({ kind: "timeout", sent });
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      sent = write({ id, method, params });
      if (!sent) {
        clearTimeout(timer);
        pending.delete(id);
        reject({ kind: "not-sent", sent: false });
      }
    });
    return response;
  }

  function rejectPending() {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject({ kind: "closed", sent: true });
    }
    pending.clear();
  }

  async function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      closing = true;
      clearTimeout(startupTimer);
      try { child.stdin.end(); } catch { /* Closing is best effort. */ }
      if (await shutdownExit(750)) return;
      try { child.kill("SIGTERM"); } catch { /* Continue to the bounded kill. */ }
      if (await shutdownExit(Math.min(Math.max(opts.stopGraceMs ?? 3000, 250), 5000))) return;
      try { child.kill("SIGKILL"); } catch { /* Exit observer remains authoritative. */ }
      if (await shutdownExit(1000)) return;
      if (!exited) {
        log("shutdown-unconfirmed");
        rejectPending();
        terminalReason = "failed";
        terminalError = "office live run shutdown unconfirmed; writer lease retained";
        completeStream("failed", terminalError);
        throw new Error(terminalError);
      }
    })();
    return shutdownPromise;
  }

  async function waitForExit(timeoutMs = 5000) {
    if (exited) return leaseReleased;
    const budget = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(timeoutMs, 60_000)) : 5000;
    let timer;
    const result = await Promise.race([
      exitPromise.then(() => leaseReleased),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), budget); }),
    ]);
    clearTimeout(timer);
    return result;
  }

  async function shutdownExit(timeoutMs) {
    const released = await waitForExit(timeoutMs);
    if (exited && !leaseReleased) throw new Error("office live run writer lease cleanup failed");
    return released;
  }

  function reserveItem(item) {
    if (!isObject(item) || typeof item.id !== "string") return undefined;
    if (items.has(item.id)) return items.get(item.id);
    if (items.size >= MAX_ITEMS) { fail("office live run item limit exceeded"); return undefined; }
    const state = { kind: item.type, streamed: "", thinking: false, toolStarted: false, completed: false };
    items.set(item.id, state);
    return state;
  }

  function trackText(delta) {
    textBytes += Buffer.byteLength(delta, "utf8");
    if (textBytes > MAX_TEXT_BYTES) { fail("office live run text limit exceeded"); return false; }
    return true;
  }

  function startTool(item, state) {
    if (state.toolStarted) return;
    state.toolStarted = true;
    let input;
    if (item.type === "commandExecution") input = { command: textValue(item.command), cwd: textValue(item.cwd) };
    else if (item.type === "fileChange") input = { changes: boundedOutput(item.changes ?? []) };
    else if (item.type === "mcpToolCall") input = { server: textValue(item.server), tool: textValue(item.tool), arguments: boundedOutput(item.arguments ?? {}) };
    else input = { namespace: textValue(item.namespace), tool: textValue(item.tool), arguments: boundedOutput(item.arguments ?? {}) };
    enqueue({ type: "tool_use", id: item.id, name: item.type === "dynamicToolCall" ? textValue(item.tool) || item.type : item.type, input });
  }

  function onItem(item, completed) {
    const state = reserveItem(item);
    if (!state || state.completed) return;
    if (item.type === "agentMessage") {
      if (completed) {
        const content = textValue(item.text);
        // Deltas already count toward the text budget. Only count the suffix
        // once when the authoritative completed item matches those deltas.
        const uncounted = state.streamed && content.startsWith(state.streamed) ? content.slice(state.streamed.length) : content;
        if (content && trackText(uncounted)) {
          // Completed text is authoritative; delta events are display-only.
          if (item.phase !== "commentary") lastFinalText = content;
          if (!state.streamed) enqueue({ type: "text", delta: content });
          else if (content.startsWith(state.streamed) && content.length > state.streamed.length) {
            enqueue({ type: "text", delta: content.slice(state.streamed.length) });
          }
        }
      }
    } else if (item.type === "reasoning") {
      // Only public summary is surfaced. Raw reasoning content is never emitted.
      if (completed && !state.thinking && Array.isArray(item.summary)) {
        const summary = item.summary.map((part) => typeof part === "string" ? part : textValue(part?.text)).join("\n");
        if (summary && trackText(summary)) enqueue({ type: "thinking", delta: summary });
      }
    } else if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(item.type)) {
      startTool(item, state);
      if (completed) {
        const output = item.aggregatedOutput ?? item.output ?? item.result ?? item.contentItems ?? item.changes ?? "";
        enqueue({ type: "tool_result", id: item.id, output: boundedOutput(output),
          isError: item.status === "failed" || item.status === "declined" || item.success === false || item.error != null || (typeof item.exitCode === "number" && item.exitCode !== 0) });
      }
    }
    if (completed) state.completed = true;
  }

  function onNotification(method, params) {
    if (!isObject(params) || terminal) return;
    if (params.threadId && params.threadId !== threadId) return;
    if (method === "turn/started") {
      if (startingTurn && typeof params.turn?.id === "string" && !completedTurnId) activeTurnId = params.turn.id;
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const raw = params.tokenUsage?.last ?? params.tokenUsage?.total;
      if (activeTurnId && params.turnId === activeTurnId && raw) usage = { inputTokens: tokenValue(raw.inputTokens), outputTokens: tokenValue(raw.outputTokens),
        cachedInputTokens: tokenValue(raw.cachedInputTokens), reasoningOutputTokens: tokenValue(raw.reasoningOutputTokens) };
      return;
    }
    const notificationTurnId = params.turnId ?? params.turn?.id;
    if (!activeTurnId || notificationTurnId !== activeTurnId) {
      // thread/resume can report history; it is never part of this new turn.
      return;
    }
    if (method === "model/rerouted" && params.toModel !== MODEL) {
      fail("office live run model changed unexpectedly");
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      onItem(params.item, method === "item/completed");
    } else if (method === "item/agentMessage/delta") {
      const state = reserveItem({ id: params.itemId, type: "agentMessage" });
      const delta = textValue(params.delta);
      if (state && !state.completed && delta && trackText(delta)) {
        state.streamed += delta;
        enqueue({ type: "text", delta });
      }
    } else if (method === "item/reasoning/summaryTextDelta") {
      const state = reserveItem({ id: params.itemId, type: "reasoning" });
      const delta = textValue(params.delta);
      if (state && !state.completed && delta && trackText(delta)) {
        state.thinking = true;
        enqueue({ type: "thinking", delta });
      }
    } else if (method === "error" && params.willRetry !== true) {
      fail("office live run turn reported an error");
    } else if (method === "turn/completed") {
      // The terminal payload can contain the authoritative completed items even
      // when an individual completion notification was absent.
      if (Array.isArray(params.turn?.items)) {
        for (const item of params.turn.items) { if (terminal) return; onItem(item, true); }
      }
      completedTurnId = activeTurnId;
      activeTurnId = undefined;
      const status = params.turn?.status;
      if (status === "completed") finish(stopped ? "interrupted" : "normal");
      else if (status === "interrupted") finish("interrupted");
      else fail("office live run turn failed");
    }
  }

  function onMessage(message) {
    if (!isObject(message)) { fail("office live run protocol message is invalid"); return; }
    if (Object.hasOwn(message, "id") && !message.method) {
      const entry = pending.get(message.id);
      if (!entry) return; // Late timed-out responses must never cause a resend.
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject({ kind: "rpc", sent: true, error: message.error });
      else entry.resolve(message.result);
    } else if (typeof message.method === "string" && Object.hasOwn(message, "id")) {
      // Never approve unexpected server requests. The error is protocol metadata.
      write({ id: message.id, error: { code: -32601, message: "Office live run does not support server requests" } });
      fail("office live run received an unsupported server request");
    } else if (typeof message.method === "string") {
      onNotification(message.method, message.params);
    }
  }

  function parseStdout(chunk, final = false) {
    if (protocolBroken) return;
    stdoutBuffer += final ? decoder.end() : decoder.write(chunk);
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        protocolBroken = true; stdoutBuffer = "";
        fail("office live run protocol line limit exceeded"); return;
      }
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line)); } catch {
        protocolBroken = true; stdoutBuffer = "";
        fail("office live run returned invalid JSON"); return;
      }
    }
    if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_LINE_BYTES) {
      protocolBroken = true; stdoutBuffer = "";
      fail("office live run protocol buffer limit exceeded"); return;
    }
    if (final && stdoutBuffer.trim()) {
      try { onMessage(JSON.parse(stdoutBuffer)); } catch { fail("office live run ended with incomplete JSON"); }
      stdoutBuffer = "";
    }
  }

  child.stdout.on("data", (chunk) => parseStdout(chunk));
  child.stdout.on("end", () => parseStdout(undefined, true));
  child.stdout.on("error", () => fail("office live run stdout failed"));
  child.stderr.on("data", (chunk) => { stderrBytes = Math.min(MAX_LINE_BYTES, stderrBytes + chunk.length); });
  child.stderr.on("error", () => { /* No stderr content is retained or forwarded. */ });
  child.stdin.on("error", () => fail("office live run stdin failed"));
  child.on("error", () => fail("office live run process failed to start"));
  child.on("close", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    clearTimeout(startupTimer);
    rejectPending();
    try {
      writerLease.release();
      leaseReleased = true;
    } catch {
      terminalReason = "failed";
      terminalError = "office live run writer lease cleanup failed; writer remains blocked";
    }
    if (!terminal) {
      if (!leaseReleased) finish("failed");
      else if (stopped) finish("interrupted");
      else fail("office live run process closed before turn completion");
    }
    completeStream(leaseReleased ? terminalReason ?? "failed" : "failed", terminalError);
    resolveExit(exitInfo);
    log("closed", { code, signal, stderrBytes, leaseReleased });
  });

  startupTimer = setTimeout(() => fail("office live run startup timed out"), STARTUP_MS);
  const ready = (async () => {
    try {
      await rpc("initialize", { clientInfo: { name: "office-live-run", title: "Office Live Run", version: "1.0.0" }, capabilities: { explicitGatewayOauth: true } });
      if (stopped || terminal) return;
      if (!write({ method: "initialized" })) throw { kind: "not-sent" };
      const params = { cwd: opts.cwd, model: MODEL, approvalPolicy: "never", sandbox, config: { model_reasoning_effort: "high" } };
      const response = await rpc(threadId ? "thread/resume" : "thread/start", threadId ? { ...params, threadId, excludeTurns: true } : params);
      if (stopped || terminal) return;
      const returnedId = response?.thread?.id;
      if (typeof returnedId !== "string" || (threadId && threadId !== returnedId)) throw { kind: "thread-mismatch" };
      if (response.model !== MODEL || response.approvalPolicy !== "never" ||
          (response.reasoningEffort != null && response.reasoningEffort !== "high") ||
          typeof response.cwd !== "string" || resolve(response.cwd).toLowerCase() !== resolve(opts.cwd).toLowerCase() ||
          response.sandbox?.type !== (sandbox === "read-only" ? "readOnly" : "workspaceWrite")) {
        throw { kind: "effective-settings-mismatch" };
      }
      threadId = returnedId;
      enqueue({ type: "system", threadId, sessionId: threadId, cwd: opts.cwd, model: MODEL });
      startingTurn = true;
      const result = await rpc("turn/start", { threadId, input: initialInput, cwd: opts.cwd, model: MODEL, effort: "high", approvalPolicy: "never", sandboxPolicy: response.sandbox });
      const returnedTurn = result?.turn?.id;
      if (typeof returnedTurn !== "string" || (activeTurnId && activeTurnId !== returnedTurn) || (completedTurnId && completedTurnId !== returnedTurn)) {
        throw { kind: "turn-mismatch" };
      }
      if (!terminal && !stopped) activeTurnId = returnedTurn;
      if (!terminal && !stopped && ["completed", "interrupted", "failed"].includes(result.turn.status)) {
        onNotification("turn/completed", { threadId, turn: result.turn });
      }
      clearTimeout(startupTimer);
      log("turn-started");
    } catch {
      if (!terminal && !stopped) fail("office live run initialization failed");
    } finally { startingTurn = false; }
  })();

  async function submitSteer({ prompt: steerPrompt, sourceMessageIds, images } = {}) {
    const ids = Array.isArray(sourceMessageIds) ? [...new Set(sourceMessageIds)] : [];
    if (!ids.length || ids.length > 64 || ids.some((id) => typeof id !== "string" || !id || id.length > 256)) {
      return { status: "uncertain", reason: "invalid-source-message-ids" };
    }
    const key = JSON.stringify([...ids].sort());
    const prior = submissions.get(key);
    if (prior) return prior;
    if (ids.some((id) => messageBatches.has(id))) return { status: "uncertain", reason: "overlapping-source-message-ids" };
    let input;
    try { input = makeInput(steerPrompt, images); } catch { return { status: "not-active", reason: "invalid-input" }; }
    await ready;
    if (stopped || terminal || closing || !activeTurnId) return { status: "not-active" };
    if (submissions.size >= MAX_STEER_BATCHES) return { status: "uncertain", reason: "dedup-capacity" };
    const turnId = activeTurnId;
    const delivery = (async () => {
      try {
        const result = await rpc("turn/steer", { threadId, input, expectedTurnId: turnId, clientUserMessageId: randomUUID() });
        if (result?.turnId !== turnId) return { status: "uncertain", turnId, reason: "response-turn-mismatch" };
        return { status: "accepted", turnId };
      } catch (error) {
        // Only an explicit RPC rejection proves no acceptance. Timeouts, pipe
        // closure and unrecognized RPC errors must never be queued/replayed.
        if (error?.kind === "not-sent") return { status: "not-active", turnId };
        if (isExplicitInactiveRejection(error)) return { status: "not-active", turnId };
        return { status: "uncertain", turnId };
      }
    })();
    submissions.set(key, delivery);
    for (const id of ids) messageBatches.set(id, key);
    const result = await delivery;
    log("steer-result", { status: result.status, turnId, sourceMessageCount: ids.length });
    return result;
  }

  const handle = {
    runId,
    events: {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (queue.length) {
          const entry = queue.shift(); queueBytes -= entry.bytes;
          return Promise.resolve({ value: entry.event, done: false });
        }
        if (streamClosed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => consumers.push(resolve));
      },
      async return() { await handle.stop(); return { value: undefined, done: true }; },
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      stopPromise = (async () => {
        const turnId = activeTurnId;
        if (turnId && !terminal && !closing) {
          try { await rpc("turn/interrupt", { threadId, turnId }, 1500); } catch { /* The confirmed close/lease result below remains authoritative. */ }
        }
        if (!terminal) finish("interrupted");
        await shutdown();
        if (!exited || !leaseReleased) throw new Error("office live run writer shutdown is not confirmed");
      })();
      return stopPromise;
    },
    waitForExit,
    steer(input) {
      if (steerQueued >= MAX_STEER_QUEUE) return Promise.resolve({ status: "uncertain", reason: "steer-queue-capacity" });
      steerQueued++;
      const result = steerTail.then(() => submitSteer(input));
      steerTail = result.catch(() => undefined);
      return result.finally(() => { steerQueued--; });
    },
  };
  return handle;
}

function makeInput(prompt, images) {
  if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt, "utf8") > MAX_INPUT_BYTES) throw new Error("office live run input is invalid");
  if (images !== undefined && (!Array.isArray(images) || images.length > 16)) throw new Error("office live run images are invalid");
  const input = [{ type: "text", text: prompt }];
  for (const path of images ?? []) {
    if (typeof path !== "string" || !path || path.length > 32768) throw new Error("office live run image path is invalid");
    input.push({ type: "localImage", path });
  }
  return input;
}

function boundedOutput(value) {
  let output;
  try { output = typeof value === "string" ? value : JSON.stringify(value); } catch { output = "[unavailable]"; }
  if (typeof output !== "string") output = "[unavailable]";
  return output.length > TOOL_OUTPUT_CHARS ? output.slice(0, TOOL_OUTPUT_CHARS) + "\n[output truncated]" : output;
}

function isExplicitInactiveRejection(error) {
  if (error?.kind !== "rpc" || !isObject(error.error)) return false;
  // Do not infer receipt from a local turn-completed notification. Match only
  // explicit server rejection wording; unfamiliar errors remain uncertain.
  const message = textValue(error.error.message).toLowerCase();
  return /^(?:no active turn(?: to steer)?|no active turn found|expected turn id does not match (?:the )?active turn|turn id mismatch)(?:[.: ]|$)/.test(message);
}

function checkedLeaseHome(codexHome) {
  if (typeof codexHome !== "string" || !isAbsolute(codexHome)) throw new Error("office live run requires an absolute fixed CODEX_HOME");
  try {
    const resolved = resolve(codexHome);
    const stat = lstatSync(resolved);
    const canonical = realpathSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical.toLowerCase() !== resolved.toLowerCase()) {
      throw new Error("invalid home");
    }
    return canonical;
  } catch {
    throw new Error("office live run CODEX_HOME is not a canonical real directory");
  }
}

function claimWriterLease(codexHome, runId) {
  const home = checkedLeaseHome(codexHome);
  const path = join(home, ".office-live-writer.lock.json");
  // pid identifies this bridge owner because acquisition must precede spawn.
  // claimId is independent of caller-supplied runId and proves lease ownership.
  const payload = JSON.stringify({ schemaVersion: 1, runId, pid: process.pid, startedAt: new Date().toISOString(), claimId: randomUUID() }) + "\n";
  let fd;
  let claimStat;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, payload, "utf8");
    fsyncSync(fd);
    claimStat = fstatSync(fd, { bigint: true });
    closeSync(fd);
    fd = undefined;
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* The durable claim remains fail closed. */ } }
    // Never inspect a PID, age, or another claim and never delete on acquisition
    // failure. Even a partially written claim requires explicit recovery.
    throw new Error("office live run writer lease is held or could not be persisted; writer remains blocked");
  }
  let released = false;
  return {
    release() {
      if (released) return;
      try {
        if (checkedLeaseHome(codexHome).toLowerCase() !== home.toLowerCase()) throw new Error("home changed");
        const current = lstatSync(path, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== claimStat.dev || current.ino !== claimStat.ino ||
            current.size !== BigInt(Buffer.byteLength(payload, "utf8")) || readFileSync(path, "utf8") !== payload) {
          throw new Error("lease ownership mismatch");
        }
        unlinkSync(path);
        released = true;
      } catch {
        throw new Error("office live run could not confirm and release its writer lease");
      }
    },
  };
}
