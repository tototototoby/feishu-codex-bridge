import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { loadOfficeAssistantFromProcess } from "./office-policy.mjs";
import { completeOfficePendingOAuth } from "./office-user-oauth.mjs";

const STATUS_ARGS = Object.freeze(["auth", "status", "--json"]);
const USER_INFO_ARGS = Object.freeze(["api", "GET", "/open-apis/authen/v1/user_info", "--as", "user", "--json"]);
const flights = new Map();
const uncertainProfiles = new Set();
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
class AuthFailure extends Error {}
const fail = (code) => new AuthFailure(`office-user-auth-${code}`);

async function regularFile(path, limit) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || !samePath(await realpath(path), path)) throw fail("config");
}

async function loadContext() {
  const assistant = loadOfficeAssistantFromProcess({ requireReady: true });
  if (assistant.larkCliIdentityPreset !== "user-default") return { assistant, required: false };
  await regularFile(assistant.assistantFile, 64 * 1024);
  const descriptor = JSON.parse(await readFile(assistant.assistantFile, "utf8"));
  if (descriptor.larkCliIdentityPreset !== "user-default" || descriptor.userAuthSetupApproved !== true ||
      descriptor.userCliApprovedOpenId !== assistant.allowedOpenId || descriptor.allowedOpenId !== assistant.allowedOpenId ||
      descriptor.appId !== assistant.appId || descriptor.verifiedAppId !== assistant.appId ||
      typeof descriptor.expectedTenantKey !== "string" || !descriptor.expectedTenantKey ||
      descriptor.verifiedTenantKey !== descriptor.expectedTenantKey ||
      typeof descriptor.expectedUserUnionId !== "string" || !/^on_[A-Za-z0-9_-]+$/.test(descriptor.expectedUserUnionId) ||
      descriptor.verifiedUserUnionId !== descriptor.expectedUserUnionId) throw fail("config");
  const installRoot = process.env.LOCALAPPDATA;
  if (typeof installRoot !== "string" || !isAbsolute(installRoot)) throw fail("unavailable");
  // A fixed installation suffix under the host's trusted local application root;
  // neither run options, model output, PATH nor assistant descriptors choose it.
  const binary = join(installRoot, "Programs", "nodejs", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe");
  await regularFile(binary, 256 * 1024 * 1024);
  const profileDirectory = join(assistant.bridgeHome, "profiles", assistant.profile);
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "USERPROFILE", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "OS"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    LARK_CHANNEL: "1",
    LARK_CHANNEL_HOME: assistant.bridgeHome,
    LARK_CHANNEL_PROFILE: assistant.profile,
    LARK_CHANNEL_CONFIG: join(profileDirectory, "lark-cli-source", "config.json"),
    LARKSUITE_CLI_CONFIG_DIR: join(profileDirectory, "lark-cli"),
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
  });
  const identity = { appId: assistant.appId, openId: assistant.allowedOpenId,
    tenantKey: descriptor.expectedTenantKey, unionId: descriptor.expectedUserUnionId };
  return { assistant, required: true, binary, env, identity,
    key: assistant.profileCliConfigPath.toLowerCase(), fingerprint: JSON.stringify(identity) };
}

function runCli(context, args, signal, { parseJson = true } = {}) {
  if (signal.aborted) return Promise.reject(fail("stopped"));
  if (!parseJson && (args.length !== 5 || args[0] !== "auth" || args[1] !== "login" ||
      args[2] !== "--device-code" || typeof args[3] !== "string" || args[4] !== "--json")) return Promise.reject(fail("oauth-config"));
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(context.binary, args, { cwd: context.assistant.workspace, env: context.env,
        windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch { reject(fail("unavailable")); return; }
    let settled = false;
    let failure;
    let closeTimer;
    let outputBytes = 0;
    const chunks = [];
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      signal.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(fail("cli-exit")); return; }
      if (!parseJson) {
        let response;
        try { response = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        if (record(response) && response.ok === false) { reject(fail("oauth-completion")); return; }
        resolvePromise({ completedExitZero: true });
        return;
      }
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(fail("json")); }
    };
    const terminate = (reason) => {
      if (settled || failure) return;
      failure = fail(reason);
      try { child.kill("SIGKILL"); } catch {}
      // Do not allow another host command if Windows cannot confirm this one
      // closed. A restart/manual investigation is required for that profile.
      closeTimer = setTimeout(() => {
        uncertainProfiles.add(context.key);
        failure = fail("close-timeout");
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      }, 2_000);
    };
    const abort = () => terminate("stopped");
    const timer = setTimeout(() => terminate("timeout"), 20_000);
    signal.addEventListener("abort", abort, { once: true });
    const capture = (chunk, stdout) => {
      if (settled || failure) return;
      outputBytes += chunk.length;
      if (outputBytes > 128 * 1024) { terminate("output-limit"); return; }
      if (stdout) chunks.push(chunk);
      // Stderr is bounded and discarded. No CLI response or identity is logged.
    };
    child.stdout.on("data", (chunk) => capture(chunk, true));
    child.stderr.on("data", (chunk) => capture(chunk, false));
    child.once("error", () => {
      if (!child.pid) { failure = fail("unavailable"); finish(null); }
      else terminate("unavailable");
    });
    child.once("close", finish);
  });
}

function checkStatus(status, context, after) {
  const user = status?.identities?.user;
  if (!record(status) || !record(status.identities) || !record(user) || status.brand !== "feishu" ||
      !["auto", "user"].includes(status.defaultAs) || status.identity !== "user" || user.available !== true ||
      !["ready", "needs_refresh"].includes(user.status) || !["valid", "needs_refresh"].includes(user.tokenStatus) ||
      typeof user.expiresAt !== "string" || !Number.isFinite(Date.parse(user.expiresAt))) throw fail("status-schema");
  if (status.appId !== context.identity.appId || user.openId !== context.identity.openId) throw fail("identity");
  if (after && (user.status !== "ready" || user.tokenStatus !== "valid" || Date.parse(user.expiresAt) <= Date.now())) throw fail("invalid-token");
  return Date.parse(user.expiresAt);
}

async function verifyCredentials(context, signal, scopes = []) {
  checkStatus(await runCli(context, STATUS_ARGS, signal), context, false);
  const response = await runCli(context, USER_INFO_ARGS, signal);
  if (!record(response) || response.ok !== true || response.identity !== "user" || !record(response.data)) throw fail("api");
  const user = response.data;
  if (user.open_id !== context.identity.openId || user.tenant_key !== context.identity.tenantKey ||
      user.union_id !== context.identity.unionId) throw fail("identity");
  const status = await runCli(context, STATUS_ARGS, signal);
  const expiresAt = checkStatus(status, context, true);
  if (scopes.length > 0) {
    if (typeof status.identities.user.scope !== "string") throw fail("oauth-scopes");
    const storedScopes = new Set(status.identities.user.scope.split(/[\s,]+/).filter(Boolean));
    if (!scopes.every((scope) => storedScopes.has(scope))) throw fail("oauth-scopes");
  }
  // This validates one launch boundary. A long model task may outlive the token;
  // this helper performs no polling and cannot repair an in-sandbox later refresh.
  return expiresAt;
}

async function preflight(context, signal, opts) {
  const completedExpiry = await completeOfficePendingOAuth(context, signal, opts, { runCli, fail, verifyCredentials,
    verifyBeforeCompletion: async () => checkStatus(await runCli(context, STATUS_ARGS, signal), context, false) });
  return completedExpiry ?? verifyCredentials(context, signal);
}

function acquire(context, opts) {
  if (uncertainProfiles.has(context.key)) throw fail("close-timeout");
  let flight = flights.get(context.key);
  if (flight && flight.fingerprint !== context.fingerprint) throw fail("config");
  if (!flight) {
    const controller = new AbortController();
    flight = { controller, fingerprint: context.fingerprint, waiters: 0, settled: false, sources: new Set(), revision: 0 };
    flights.set(context.key, flight);
    flight.promise = Promise.resolve().then(async () => {
      let expiresAt;
      let checked;
      let rounds = 0;
      do {
        if (++rounds > 4) throw fail("oauth-busy");
        checked = flight.revision;
        expiresAt = await preflight(context, controller.signal, { officeSourceMessageIds: [...flight.sources] });
      } while (checked !== flight.revision);
      return expiresAt;
    }).finally(() => {
      flight.settled = true;
      if (flights.get(context.key) === flight) flights.delete(context.key);
    });
  }
  if (Array.isArray(opts?.officeSourceMessageIds)) {
    for (const source of opts.officeSourceMessageIds) {
      if (!flight.sources.has(source)) { flight.sources.add(source); flight.revision += 1; }
    }
  }
  flight.waiters += 1;
  let released = false;
  let cleanup;
  return { promise: flight.promise, release() {
    if (released) return cleanup;
    released = true;
    flight.waiters -= 1;
    if (flight.waiters === 0 && !flight.settled) {
      flight.controller.abort();
      cleanup = flight.promise.catch(() => {});
    }
    return cleanup;
  } };
}

export function createOfficeUserAuthRun(opts, runOnce) {
  let active;
  let lease;
  let interrupted = false;
  let failure;
  let cancel;
  const cancelled = new Promise((resolvePromise) => { cancel = resolvePromise; });
  const ready = (async () => {
    try {
      const context = await loadContext();
      if (interrupted) throw fail("stopped");
      if (context.required) {
        lease = acquire(context, opts);
        let expiresAt;
        try {
          expiresAt = await Promise.race([lease.promise, cancelled.then(() => { throw fail("stopped"); })]);
        } finally { await lease.release(); }
        if (interrupted) throw fail("stopped");
        const current = await loadContext();
        if (!current.required || current.key !== context.key || current.fingerprint !== context.fingerprint) throw fail("config");
        if (expiresAt <= Date.now()) throw fail("invalid-token");
      }
      if (interrupted) throw fail("stopped");
      active = runOnce(opts);
    } catch (error) {
      failure = error instanceof AuthFailure ? error.message : "office-user-auth-config";
    }
  })();
  return {
    runId: opts.runId,
    async stop() {
      interrupted = true;
      cancel();
      await lease?.release();
      await ready;
      if (active) await active.stop();
    },
    async waitForExit(timeoutMs) {
      const budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
      const start = Date.now();
      let timer;
      const pending = Symbol();
      const result = await Promise.race([ready, new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise(pending), budget); })]);
      clearTimeout(timer);
      if (result === pending) return false;
      return active ? active.waitForExit(Math.max(0, budget - (Date.now() - start))) : true;
    },
    events: {
      async *[Symbol.asyncIterator]() {
        await ready;
        if (active) { yield* active.events; return; }
        if (interrupted) { yield { type: "done", terminationReason: "interrupted" }; return; }
        yield { type: "error", message: `本人授权预检未完成（${failure ?? "office-user-auth-config"}）；模型未启动。`, terminationReason: "failed" };
      },
    },
  };
}
