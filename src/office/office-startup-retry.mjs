import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadOfficeAssistantFromProcess } from "./office-policy.mjs";

const ROUTING_TIMEOUT = "workspace routing discovery timed out";
const RECONNECT = /^Reconnecting\.\.\. [1-5]\/5 \(workspace routing discovery timed out\)$/;
const messageId = (value) => typeof value === "string" && /^om_[A-Za-z0-9_-]+$/.test(value);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const hash = (value) => createHash("sha256").update(value).digest("hex");

// This proof sees every original stdout line before the lossy bridge translator.
// Anything outside these exact startup records permanently disqualifies replay.
export function createOfficeStartupProof() {
  let valid = true;
  let phase = "thread";
  let exactError = false;
  let complete = false;
  let lines = 0;
  let bytes = 0;
  const digest = createHash("sha256");
  let child;
  let closeTimer;
  let closeObserved = false;
  let timedOut = false;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  function watchTerminalClose() {
    if (!child || closeTimer || closeObserved) return;
    closeTimer = setTimeout(() => {
      // A terminal event or process exit is already present. Never retry a
      // process that required cleanup, regardless of its eventual exit code.
      timedOut = true;
      valid = false;
      complete = false;
      try { child.stdout.destroy(); } catch {}
      try { child.kill("SIGKILL"); } catch {}
      // Bounded fail-closed delivery also covers an OS kill without a close event.
      resolveClosed({ code: null, signal: "office-startup-close-timeout" });
    }, 8_000);
  }
  return {
    attach(processChild) {
      child = processChild;
      child.once("close", (code, signal) => {
        closeObserved = true;
        if (closeTimer) clearTimeout(closeTimer);
        resolveClosed({ code, signal });
      });
      // An inherited pipe can outlive its CLI even after a real exit event.
      child.once("exit", watchTerminalClose);
    },
    waitForClose() { return closed; },
    observe(line) {
      lines += 1;
      bytes += Buffer.byteLength(line, "utf8") + 1;
      digest.update(line).update("\n");
      let raw;
      try { raw = JSON.parse(line); } catch { valid = false; return; }
      // Bound cleanup for every terminal outcome. Retry eligibility below
      // only accepts the precise routing failure and natural process close.
      if (record(raw) && (raw.type === "turn.failed" || raw.type === "turn.completed")) watchTerminalClose();
      if (!valid || lines > 256 || bytes > 128 * 1024 || line.includes("\uFFFD")) { valid = false; return; }
      // Canonical compact JSON rejects duplicate keys as well as hidden fields.
      if (!record(raw) || JSON.stringify(raw) !== line) { valid = false; return; }
      if (phase === "thread" && onlyKeys(raw, ["type", "thread_id"]) && raw.type === "thread.started" &&
          typeof raw.thread_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(raw.thread_id)) {
        phase = "turn";
        return;
      }
      if (phase === "turn" && onlyKeys(raw, ["type"]) && raw.type === "turn.started") {
        phase = "errors";
        return;
      }
      if (phase === "errors" && onlyKeys(raw, ["type", "message"]) && raw.type === "error" &&
          (raw.message === ROUTING_TIMEOUT || RECONNECT.test(raw.message))) {
        if (raw.message === ROUTING_TIMEOUT) exactError = true;
        return;
      }
      if (phase === "errors" && onlyKeys(raw, ["type", "error"]) && raw.type === "turn.failed" &&
          onlyKeys(raw.error, ["message"]) && raw.error.message === ROUTING_TIMEOUT) {
        phase = "failed";
        return;
      }
      valid = false;
    },
    finish() { complete = !timedOut; },
    result(exit) {
      return {
        safe: valid && complete && phase === "failed" && exactError &&
          Number.isInteger(exit?.code) && exit.code !== 0 && exit.signal == null &&
          !exit.runtimeError && !exit.stopReason,
        stdoutLines: lines,
        stdoutBytes: bytes,
        stdoutSha256: digest.copy().digest("hex"),
      };
    },
  };
}

async function claimRetry(opts, proof) {
  const assistant = loadOfficeAssistantFromProcess({ requireReady: true });
  const sourceIds = opts.officeSourceMessageIds;
  if (typeof opts.runId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(opts.runId) ||
      !Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 50 ||
      !sourceIds.every(messageId) || new Set(sourceIds).size !== sourceIds.length) return null;
  const ids = [...sourceIds].sort();
  // Read existing intake claims; never clear them or enqueue the inbound message again.
  const inboundPath = join(assistant.bridgeHome, ".office-inbound-ledger.json");
  const inboundStat = await lstat(inboundPath);
  if (!inboundStat.isFile() || inboundStat.isSymbolicLink() || inboundStat.size > 4 * 1024 * 1024) return null;
  const inbound = JSON.parse(await readFile(inboundPath, "utf8"));
  if (inbound.schemaVersion !== 1 || inbound.appId !== assistant.appId || !record(inbound.messages) ||
      !ids.every((id) => inbound.messages[id]?.status === "claimed" && /^oc_[A-Za-z0-9_-]+$/.test(inbound.messages[id]?.chatId ?? ""))) return null;
  const directory = join(assistant.bridgeHome, ".office-startup-retry-claims");
  await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null;
  const data = {
    schemaVersion: 1, appId: assistant.appId, runId: opts.runId, sourceMessageIds: ids,
    attempts: 1, status: "retry_claimed", claimedAt: new Date().toISOString(),
    reason: ROUTING_TIMEOUT, ...proof,
  };
  // Each original source gets its own exclusive claim, including across different
  // run IDs or overlapping batches. Any existing/partial/uncertain claim blocks replay.
  const claimNames = [
    `run-${hash(JSON.stringify([assistant.appId, opts.runId, ids]))}.json`,
    ...ids.map((id) => `source-${hash(JSON.stringify([assistant.appId, id]))}.json`),
  ];
  const handles = [];
  try {
    for (const name of claimNames) {
      const handle = await open(join(directory, name), "wx", 0o600);
      handles.push(handle);
      await handle.writeFile(JSON.stringify(data), "utf8");
      await handle.sync();
    }
  } catch {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    // Intentionally retain every partial claim. A later restart must not guess.
    return null;
  }
  return {
    async status(status) {
      data.status = status;
      data.updatedAt = new Date().toISOString();
      for (const handle of handles) {
        const body = Buffer.from(JSON.stringify(data));
        await handle.truncate(0);
        let offset = 0;
        while (offset < body.length) {
          const { bytesWritten } = await handle.write(body, offset, body.length - offset, offset);
          if (bytesWritten < 1) throw new Error("retry-claim-write-incomplete");
          offset += bytesWritten;
        }
        await handle.sync();
      }
    },
    async close() { await Promise.allSettled(handles.map((handle) => handle.close())); },
  };
}

export function createOfficeStartupRetryRun(opts, runOnce, onEvent = () => {}) {
  let active = runOnce(opts);
  let interrupted = false;
  return {
    runId: opts.runId,
    async stop() { interrupted = true; await active.stop(); },
    waitForExit(timeoutMs) { return active.waitForExit(timeoutMs); },
    events: {
        async *[Symbol.asyncIterator]() {
          const buffered = [];
          let bufferedBytes = 0;
          let startupOnly = true;
          for await (const event of active.events) {
            if (startupOnly && (event.type === "system" || event.type === "error")) {
              buffered.push(event);
              bufferedBytes += Buffer.byteLength(JSON.stringify(event), "utf8");
              if (buffered.length <= 256 && bufferedBytes <= 128 * 1024) continue;
              // Overflow resumes ordinary delivery and permanently gives up
              // retry, even if the bridge translated fewer raw records.
              startupOnly = false;
              yield* buffered.splice(0);
            } else {
              startupOnly = false;
              yield* buffered.splice(0);
              yield event;
            }
          }
          if (!startupOnly) return;
          // Exhaust stdout and await close (exit + all stdio), before exposing
          // the terminal error or spawning anything else.
          const proof = await active.officeStartupResult();
          let claim = null;
          if (!interrupted && proof.safe) claim = await claimRetry(opts, proof).catch(() => null);
          if (!claim) { yield* buffered; return; }
          try {
            if (interrupted) { yield* buffered; return; }
            // Persist before spawn. A crash at this boundary stays uncertain.
            try { await claim.status("retry_started"); } catch { yield* buffered; return; }
            if (interrupted) { yield* buffered; return; }
            active = runOnce(opts);
            try { onEvent({ runId: opts.runId, attempt: 1, sourceCount: opts.officeSourceMessageIds.length }); } catch {}
            const terminal = [];
            let terminalBytes = 0;
            let bufferTerminal = true;
            for await (const event of active.events) {
              if (bufferTerminal && (event.type === "error" || event.type === "done")) {
                terminal.push(event);
                terminalBytes += Buffer.byteLength(JSON.stringify(event), "utf8");
                if (terminal.length <= 256 && terminalBytes <= 128 * 1024) continue;
                bufferTerminal = false;
                yield* terminal.splice(0);
              } else yield event;
            }
            await active.officeStartupResult();
            await claim.status("retry_finished").catch(() => {});
            yield* terminal;
          } finally {
            await claim.close();
          }
        },
    },
  };
}
