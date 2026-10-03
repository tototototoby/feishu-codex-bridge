import { createHash, randomUUID } from "node:crypto";
import { createRequire, isBuiltin } from "node:module";
import { spawn } from "node:child_process";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertOfficeRunOptions,
  expectedAssistantPaths,
  listOfficeAssistants,
  loadOfficeAssistant,
} from "./office-policy.mjs";
import { CONFIG_PATH, DATA_ROOT, PROJECT_ROOT, officeRoot, upstreamRoot, toolPath } from "../settings.mjs";

const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
const TASK_CONTROLLER = join(RUNTIME_DIR, "office-task.ps1");
const STOCK_PACKAGE_ROOT = upstreamRoot();
const STOCK_PACKAGE_JSON = join(STOCK_PACKAGE_ROOT, "package.json");
const STOCK_CLI = join(STOCK_PACKAGE_ROOT, "dist", "cli.js");
const STOCK_VERSION = "0.7.1";
const STOCK_SHA256 = "E9CDEED0C5E09C8E5155D00D11240152EF37B261DAF88CBC56E4A02E244C5601";
const PATCHSET = "office-runtime-v1";
const MAX_CAPTURE_BYTES = 8 * 1024;
const TASK_NAMESPACE = `Fcb-${createHash("sha256").update(`${resolve(PROJECT_ROOT)}|${resolve(DATA_ROOT)}`.toLowerCase()).digest("hex").slice(0, 12)}`;

for (const key of Object.keys(process.env)) {
  if (/^(?:LARK|FEISHU|OPENCLAW|HERMES|CODEX_)/i.test(key) || key === "NODE_OPTIONS" || key === "NODE_PATH") {
    delete process.env[key];
  }
}

const PROCESS_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$payload = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()) -ErrorAction Stop
$result = [ordered]@{
  pid = [int]$payload.pid
  alive = $false
  verified = $false
  pathMatches = $false
  commandMatches = $false
  ownerMatches = $false
}
try {
  $proc = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + [int]$payload.pid) -ErrorAction Stop
  if ($proc) {
    $result.alive = $true
    $actualPath = [System.IO.Path]::GetFullPath([string]$proc.ExecutablePath)
    $expectedPath = [System.IO.Path]::GetFullPath([string]$payload.nodePath)
    $result.pathMatches = [string]::Equals($actualPath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)
    $cmd = [string]$proc.CommandLine
    $profilePattern = '(?i)(?:^|\s)--profile\s+"?' + [regex]::Escape([string]$payload.profile) + '"?(?:\s|$)'
    $configPattern = '(?i)(?:^|\s)--config\s+"?' + [regex]::Escape([string]$payload.configPath) + '"?(?:\s|$)'
    $result.commandMatches = $cmd.IndexOf([string]$payload.cliPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      [regex]::IsMatch($cmd, '(?i)(?:^|\s)run(?:\s|$)') -and
      [regex]::IsMatch($cmd, $profilePattern) -and
      [regex]::IsMatch($cmd, $configPattern)
    $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid -ErrorAction Stop
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $result.ownerMatches = ($owner.ReturnValue -eq 0 -and [string]$owner.Sid -eq $currentSid)
    $result.verified = $result.pathMatches -and $result.commandMatches -and $result.ownerMatches
  }
} catch {
  $result.verified = $false
}
ConvertTo-Json -InputObject ([pscustomobject]$result) -Compress -Depth 3
`;

function usage() {
  console.log("Office assistant runtime");
  console.log("  office-entry.mjs status <assistant-key>");
  console.log("  office-entry.mjs prepare");
  console.log("  office-entry.mjs task-install <assistant-key>");
  console.log("  office-entry.mjs start <assistant-key>");
  console.log("  office-entry.mjs stop <assistant-key>");
}

function samePath(left, right) {
  return typeof left === "string" && typeof right === "string" &&
    resolve(left).replaceAll("/", "\\").toLowerCase() === resolve(right).replaceAll("/", "\\").toLowerCase();
}

async function fileExistsRegular(filePath) {
  try {
    const stat = await lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function pathEntryExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex").toUpperCase();
}

function replaceExactlyOnce(source, before, after, marker) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`stock patch anchor mismatch: ${marker}`);
  return source.replace(before, after);
}

function rewriteBareStaticImports(source, stockRequire) {
  const importLine = /^import [^\n]*?\sfrom\s+(["'])([^"']+)\1;\s*$/gm;
  const lines = [...source.matchAll(importLine)];
  let externalCount = 0;
  for (const match of lines) {
    const [fullLine, quote, specifier] = match;
    if (specifier.startsWith(".") || isBuiltin(specifier) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) continue;
    const resolvedPath = stockRequire.resolve(specifier);
    const fileUrl = pathToFileURL(resolvedPath).href;
    const replacement = fullLine.replace(`${quote}${specifier}${quote}`, `${quote}${fileUrl}${quote}`);
    source = replaceExactlyOnce(source, fullLine, replacement, `external-import:${specifier}`);
    externalCount += 1;
  }
  if (externalCount < 1) throw new Error("stock external import set is empty");
  return source;
}

function patchStockSource(source) {
  const officePolicyUrl = JSON.stringify(new URL("./office-policy.mjs", import.meta.url).href);
  const officeVisibilityUrl = JSON.stringify(new URL("./office-visibility.mjs", import.meta.url).href);
  const officeRealtimeUrl = JSON.stringify(new URL("./office-realtime.mjs", import.meta.url).href);
  const officeRecoveryUrl = JSON.stringify(new URL("./office-recovery.mjs", import.meta.url).href);
  source = replaceExactlyOnce(
    source,
    "// src/cli/index.ts\nimport { Command } from \"commander\";",
    `// src/cli/index.ts\n// OFFICE_PATCHSET:${PATCHSET}:policy-import\nimport { assertOfficeRunOptions, enforceOfficeProfilePolicy, isOfficeAllowedOpenId, isOfficeRuntime, loadOfficeAssistantFromProcess } from ${officePolicyUrl};\nimport { beginOfficeVisibilityRun, finishOfficeVisibilityRun, syncOfficeVisibilityEvent } from ${officeVisibilityUrl}; // OFFICE_PATCH:visibility-import
import { beginOfficeRealtimeRun, finishOfficeRealtimeRun, updateOfficeRealtimeRun } from ${officeRealtimeUrl}; // OFFICE_PATCH:realtime-import\nimport { claimOfficeMessage, recoverOfficeMessages } from ${officeRecoveryUrl}; // OFFICE_PATCH:recovery-import\nimport { Command } from "commander";`,
    "policy-import",
  );

  source = replaceExactlyOnce(
    source,
    "function isCreator(controls, senderId) {\n  if (controls.ownerRefreshState === \"unknown\") return false;",
    "function isCreator(controls, senderId) {\n  if (isOfficeRuntime() && !isOfficeAllowedOpenId(senderId)) return false; // OFFICE_PATCH:creator-gate\n  if (controls.ownerRefreshState === \"unknown\") return false;",
    "creator-gate",
  );
  source = replaceExactlyOnce(
    source,
    "function canUseDm(profile2, controls, senderId) {\n  if (isCreator(controls, senderId)) return allow(\"owner\");",
    "function canUseDm(profile2, controls, senderId) {\n  if (isOfficeRuntime() && !isOfficeAllowedOpenId(senderId)) return deny(\"denied-user\"); // OFFICE_PATCH:p2p-gate\n  if (isCreator(controls, senderId)) return allow(\"owner\");",
    "p2p-gate",
  );
  source = replaceExactlyOnce(
    source,
    "function canUseGroup(profile2, controls, chatId, senderId) {\n  if (isCreator(controls, senderId)) return allow(\"owner\");",
    "function canUseGroup(profile2, controls, chatId, senderId) {\n  if (isOfficeRuntime()) return deny(\"denied-chat\"); // OFFICE_PATCH:group-deny\n  if (isCreator(controls, senderId)) return allow(\"owner\");",
    "group-deny",
  );
  source = replaceExactlyOnce(
    source,
    "function canRunAdminCommand(profile2, controls, senderId) {\n  if (isCreator(controls, senderId)) return allow(\"owner\");",
    "function canRunAdminCommand(profile2, controls, senderId) {\n  if (isOfficeRuntime() && !isOfficeAllowedOpenId(senderId)) return deny(\"denied-admin\"); // OFFICE_PATCH:admin-gate\n  if (isCreator(controls, senderId)) return allow(\"owner\");",
    "admin-gate",
  );

  source = replaceExactlyOnce(
    source,
    "async function applyLarkCliIdentityPolicy(context, identityPreset) {\n  const env = buildLarkChannelEnv(context);",
    "async function applyLarkCliIdentityPolicy(context, identityPreset) {\n  if (isOfficeRuntime()) identityPreset = \"bot-only\"; // OFFICE_PATCH:bot-only-identity\n  const env = buildLarkChannelEnv(context);",
    "bot-only-identity",
  );
  source = replaceExactlyOnce(
    source,
    "  const bridgeEntry = opts.bridgeEntry ?? process.argv[1] ?? \"\";",
    `  const bridgeEntry = isOfficeRuntime() ? ${JSON.stringify(STOCK_CLI)} : opts.bridgeEntry ?? process.argv[1] ?? ""; // OFFICE_PATCH:secrets-getter-stock-cli`,
    "secrets-getter-stock-cli",
  );
  source = replaceExactlyOnce(
    source,
    "  const rootDir = appPaths2.rootDir ?? dirname10(appPaths2.secretsGetterScript);\n  if (platform2 === \"win32\") {",
    `  const rootDir = appPaths2.rootDir ?? dirname10(appPaths2.secretsGetterScript);
  if (isOfficeRuntime()) { // OFFICE_PATCH:ascii-office-secrets-wrapper
    const officeAssistant = loadOfficeAssistantFromProcess({ requireReady: true });
    if (platform2 !== "win32") throw new Error("office secrets wrapper requires Windows");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(officeAssistant.profile)) throw new Error("office profile is invalid");
    const officeBody = [
      '@echo off',
      'rem Auto-generated by lark-channel-bridge office runtime. Do not edit.',
      'set "LARK_CHANNEL_HOME=%~dp0"',
      'set "LARK_CHANNEL_PROFILE=' + officeAssistant.profile + '"',
      '"%FEISHU_CODEX_NODE%" "%FEISHU_CODEX_BRIDGE_CLI%" secrets get %*',
      ''
    ].join('\\r\\n');
    await writeFileAtomic(wrapperPath, officeBody, { mode: 384 });
    return wrapperPath;
  }
  if (platform2 === "win32") {`,
    "ascii-office-secrets-wrapper",
  );
  source = replaceExactlyOnce(
    source,
    "  const mode = rawMode === \"team\" || rawMode === \"personal\" ? rawMode : ctx.controls.profileConfig.mode;",
    "  const mode = isOfficeRuntime() ? \"personal\" : rawMode === \"team\" || rawMode === \"personal\" ? rawMode : ctx.controls.profileConfig.mode; // OFFICE_PATCH:personal-mode\n",
    "personal-mode",
  );
  source = replaceExactlyOnce(
    source,
    "  const larkCliIdentity = rawLarkCliIdentity === \"user-default\" || rawLarkCliIdentity === \"bot-only\" ? rawLarkCliIdentity : ctx.controls.profileConfig.larkCli.identityPreset;",
    "  const larkCliIdentity = isOfficeRuntime() ? \"bot-only\" : rawLarkCliIdentity === \"user-default\" || rawLarkCliIdentity === \"bot-only\" ? rawLarkCliIdentity : ctx.controls.profileConfig.larkCli.identityPreset; // OFFICE_PATCH:bot-only-form\n",
    "bot-only-form",
  );

  source = replaceExactlyOnce(
    source,
    "function buildCodexArgs(input) {\n  if (input.sandbox !== \"read-only\" && input.sandbox !== \"workspace-write\" && input.sandbox !== \"danger-full-access\") {",
    "function buildCodexArgs(input) {\n  const officeRuntime = isOfficeRuntime();\n  const sandbox = officeRuntime ? input.sandbox === \"read-only\" ? \"read-only\" : \"workspace-write\" : input.sandbox;\n  const model = officeRuntime ? \"gpt-6.1-sol\" : input.model;\n  if (sandbox !== \"read-only\" && sandbox !== \"workspace-write\" && sandbox !== \"danger-full-access\") { // OFFICE_PATCH:bounded-args\n",
    "bounded-args",
  );
  source = replaceExactlyOnce(source, "    input.sandbox,\n", "    sandbox,\n", "bounded-sandbox-flag");
  source = replaceExactlyOnce(
    source,
    "    ...input.model ? [\"--model\", input.model] : [],\n",
    "    ...model ? [\"--model\", model] : [],\n    ...officeRuntime ? [\"-c\", 'model_reasoning_effort=\"high\"'] : [], // OFFICE_PATCH:request-model-effort\n",
    "request-model-effort",
  );
  source = replaceExactlyOnce(
    source,
    "    this.sandbox = opts.sandbox ?? \"danger-full-access\";",
    "    this.sandbox = opts.sandbox ?? \"workspace-write\"; // OFFICE_PATCH:no-full-sandbox-fallback",
    "no-full-sandbox-fallback",
  );

  source = replaceExactlyOnce(
    source,
    "    } else if (!this.inheritCodexHome) {\n      envOverrides.CODEX_HOME = join17(this.profileStateDir, \"codex-home\");\n    }\n    const child = spawnProcess(this.binary, args, {",
    "    } else if (!this.inheritCodexHome) {\n      envOverrides.CODEX_HOME = join17(this.profileStateDir, \"codex-home\");\n    }\n    if (isOfficeRuntime()) {\n      const officeAssistant = loadOfficeAssistantFromProcess({ requireReady: true });\n      envOverrides.LARK_CHANNEL_HOME = officeAssistant.bridgeHome;\n      envOverrides.CODEX_HOME = officeAssistant.codexHome;\n    }\n    const child = spawnProcess(this.binary, args, { // OFFICE_PATCH:process-only-homes",
    "process-only-homes",
  );

  source = replaceExactlyOnce(
    source,
    "    if (!isComplete(cfg)) throw new Error(`profile \\u914D\\u7F6E\\u4E0D\\u5B8C\\u6574\\uFF1A${profile2}`);\n    for (const m of this.managed.values()) {",
    "    if (!isComplete(cfg)) throw new Error(`profile \\u914D\\u7F6E\\u4E0D\\u5B8C\\u6574\\uFF1A${profile2}`);\n    if (isOfficeRuntime()) { enforceOfficeProfilePolicy(profileConfig, { profile: profile2, rootDir: appPaths2.rootDir, configPath, appId: cfg.accounts?.app?.id }); cfg.preferences = profileConfig.preferences; } // OFFICE_PATCH:preflight-policy\n    for (const m of this.managed.values()) {",
    "preflight-policy",
  );

  source = replaceExactlyOnce(
    source,
    "  cwdFor(chatId) {\n    return this.data.chats[chatId]?.cwd;\n  }",
    "  cwdFor(chatId) {\n    if (isOfficeRuntime()) return loadOfficeAssistantFromProcess({ requireReady: true }).workspace; // OFFICE_PATCH:fixed-workspace\n    return this.data.chats[chatId]?.cwd;\n  }",
    "fixed-workspace",
  );
  source = replaceExactlyOnce(
    source,
    "async function runStart(opts) {\n  if (opts.webUi) {",
    "async function runStart(opts) {\n  assertOfficeRunOptions(opts); // OFFICE_PATCH:single-profile-entry\n  if (opts.webUi) {",
    "single-profile-entry",
  );
  source = replaceExactlyOnce(
    source,
    "program.parseAsync(process.argv).catch((err) => {",
    `if (!isOfficeRuntime() && !["--help", "-h", "--version", "-v"].includes(process.argv[2])) {\n  console.error("Use the per-assistant office launcher.");\n  process.exit(2);\n}\nif (isOfficeRuntime() && process.argv[2] !== "run" && !["--help", "-h", "--version", "-v"].includes(process.argv[2])) {\n  console.error("The office CLI copy only accepts its mapped run command.");\n  process.exit(2);\n}\n// OFFICE_PATCH:managed-cli-boundary\nprogram.parseAsync(process.argv).catch((err) => {`,
    "managed-cli-boundary",
  );
  source = replaceExactlyOnce(
    source,
    "  const handled = await tryHandleCommand({",
    `  if (isOfficeRuntime() && accessDecision.ok && isOfficeAllowedOpenId(msg.senderId) && msg.chatType === "p2p") {\n    void syncOfficeVisibilityEvent({ kind: "input", eventId: \`input:\${emsg.messageId}\`, sourceMessageId: emsg.messageId, content: emsg.content }); // OFFICE_PATCH:visibility-input\n  }\n  const handled = await tryHandleCommand({`,
    "visibility-input",
  );
  source = replaceExactlyOnce(
    source,
    "  const { execution, cwdRealpath: cwd } = flow;",
    "  const { execution, cwdRealpath: cwd } = flow;\n  if (isOfficeRuntime()) beginOfficeVisibilityRun(scope, execution.runId, batch.map((message) => message.messageId)); // OFFICE_PATCH:visibility-run-start",
    "visibility-run-start",
  );
  source = replaceExactlyOnce(
    source,
    "  const replyMode = getMessageReplyMode(controls.cfg);\n  log.info(\"flush\", \"reply-mode\", { mode: replyMode });",
    "  const replyMode = getMessageReplyMode(controls.cfg);\n  if (isOfficeRuntime() && controls.profileConfig.agentKind === \"codex\" && replyMode === \"card\") {\n    try {\n      const officeAssistant = loadOfficeAssistantFromProcess({ requireReady: true });\n      beginOfficeRealtimeRun({ scope, runId: execution.runId, channel, chatId, sourceMessageId: lastMsg.messageId, replyInThread: sendOpts.replyInThread === true, bridgeHome: officeAssistant.bridgeHome, notifyCompletion: officeAssistant.notifyCompletion === true, onEvent: (event) => log.info(\"office-realtime-card\", event.kind, { runId: execution.runId, phase: event.phase, code: event.code, status: event.status, apiCode: event.apiCode, terminal: event.terminal, fallback: event.fallback }) });\n    } catch {}\n  } // OFFICE_PATCH:realtime-run-start\n  log.info(\"flush\", \"reply-mode\", { mode: replyMode });",
    "realtime-run-start",
  );
  source = replaceExactlyOnce(
    source,
    "  const reactionPromise = cotEnabled || replyMode === \"card\" ? void 0 : addWorkingReaction(channel, lastMsg.messageId);\n  try {\n    if (cotEnabled) {",
    "  const reactionPromise = cotEnabled || replyMode === \"card\" ? void 0 : addWorkingReaction(channel, lastMsg.messageId);\n  try {\n    if (isOfficeRuntime() && controls.profileConfig.agentKind === \"codex\" && replyMode === \"card\") {\n      let finalState;\n      try {\n        finalState = await processAgentStream(handle2, eventStream, scope, idleTimeoutMs, recordSession, async (state) => { updateOfficeRealtimeRun(scope, execution.runId, filterForPrefs(state)); });\n      } catch {\n        finalState = { blocks: [], terminal: \"error\" };\n      }\n      const officeResult = await finishOfficeRealtimeRun(scope, execution.runId, finalState);\n      if (officeResult.kind !== \"stale\" && (officeResult.kind !== \"unavailable\" || officeResult.finalDelivery)) finishOfficeVisibilityRun(scope, officeResult.content); // OFFICE_PATCH:realtime-visibility-final\n      if (officeResult.fallback && officeResult.content) {\n        await sendFinalReply({\n          channel,\n          chatId,\n          scope,\n          state: { blocks: [{ kind: \"text\", content: officeResult.content, streaming: false }], reasoning: { content: \"\", active: false }, footer: null, terminal: \"done\" },\n          replyMode,\n          sendOpts,\n          cardRenderOptions\n        });\n      }\n      return;\n    } // OFFICE_PATCH:realtime-card\n    if (cotEnabled) {",
    "realtime-card",
  );
  source = replaceExactlyOnce(
    source,
    "async function sendFinalReply(input) {\n  const body = renderText(input.state);",
    "async function sendFinalReply(input) {\n  const body = renderText(input.state);\n  if (isOfficeRuntime()) finishOfficeVisibilityRun(input.scope, body); // OFFICE_PATCH:visibility-final",
    "visibility-final",
  );
  source = replaceExactlyOnce(
    source,
    "  } finally {\n    activePolicyFingerprints.delete(scope);\n    scheduleWorkingReactionCleanup(channel, lastMsg.messageId, reactionPromise);\n  }",
    "  } finally {\n    if (isOfficeRuntime()) finishOfficeVisibilityRun(scope); // OFFICE_PATCH:visibility-final-cleanup\n    activePolicyFingerprints.delete(scope);\n    scheduleWorkingReactionCleanup(channel, lastMsg.messageId, reactionPromise);\n  }",
    "visibility-final-cleanup",
  );
  source = replaceExactlyOnce(source,
    "async function intakeMessage(deps) {",
    "async function intakeMessage(deps) {\n  if (isOfficeRuntime() && !await claimOfficeMessage(deps.msg)) return; // OFFICE_PATCH:inbound-dedup",
    "inbound-dedup");
  source = replaceExactlyOnce(source,
    "  await channel.connect();",
    `  await channel.connect();\n  if (isOfficeRuntime()) {\n    const recover = () => recoverOfficeMessages(channel, (msg) => intakeMessage({ channel, agent, sessions: sessions2, sessionCatalog, workspaces, activeRuns, pending, msg, controls, chatModeCache, logThreadModeOverride, executor, pool })).catch(() => log.warn("office-recovery", "recover-deferred", {}));\n    await recover();\n    const recoveryTimer = setInterval(recover, 30000);\n    recoveryTimer.unref?.();\n  } // OFFICE_PATCH:recovery-inbox`,
    "recovery-inbox");
  return source;
}

async function buildExpectedOfficeCli() {
  const packageJson = JSON.parse(await readFile(STOCK_PACKAGE_JSON, "utf8"));
  if (packageJson.version !== STOCK_VERSION) throw new Error("stock bridge version does not match the office pin");
  const stockSource = await readFile(STOCK_CLI, "utf8");
  if (sha256(stockSource) !== STOCK_SHA256) throw new Error("stock bridge source hash does not match the office pin");
  const stockRequire = createRequire(STOCK_PACKAGE_JSON);
  let patched = patchStockSource(stockSource);
  patched = rewriteBareStaticImports(patched, stockRequire);
  const marker = `// OFFICE_PATCHSET:${PATCHSET}:stock=${STOCK_VERSION}:${STOCK_SHA256}`;
  const importAnchor = `// src/cli/index.ts\n// OFFICE_PATCHSET:${PATCHSET}:policy-import\n`;
  patched = replaceExactlyOnce(patched, importAnchor, `${marker}\n${importAnchor}`, "patchset-marker");
  const requiredMarkers = [
    marker,
    "OFFICE_PATCH:creator-gate",
    "OFFICE_PATCH:p2p-gate",
    "OFFICE_PATCH:group-deny",
    "OFFICE_PATCH:admin-gate",
    "OFFICE_PATCH:bot-only-identity",
    "OFFICE_PATCH:secrets-getter-stock-cli",
    "OFFICE_PATCH:personal-mode",
    "OFFICE_PATCH:bot-only-form",
    "OFFICE_PATCH:bounded-args",
    "OFFICE_PATCH:request-model-effort",
    "OFFICE_PATCH:no-full-sandbox-fallback",
    "OFFICE_PATCH:process-only-homes",
    "OFFICE_PATCH:preflight-policy",
    "OFFICE_PATCH:fixed-workspace",
    "OFFICE_PATCH:single-profile-entry",
    "OFFICE_PATCH:managed-cli-boundary",
    "OFFICE_PATCH:ascii-office-secrets-wrapper",
    "OFFICE_PATCH:visibility-import",
    "OFFICE_PATCH:visibility-input",
    "OFFICE_PATCH:visibility-run-start",
    "OFFICE_PATCH:visibility-final",
    "OFFICE_PATCH:visibility-final-cleanup",
    "OFFICE_PATCH:realtime-import",
    "OFFICE_PATCH:realtime-run-start",
    "OFFICE_PATCH:realtime-card",
    "OFFICE_PATCH:realtime-visibility-final",
    "OFFICE_PATCH:recovery-import",
    "OFFICE_PATCH:inbound-dedup",
    "OFFICE_PATCH:recovery-inbox",
  ];
  for (const required of requiredMarkers) {
    if (!patched.includes(required)) throw new Error("generated office CLI patch marker is missing");
  }
  return patched;
}

async function writeTextAtomic(path, text) {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
}

async function ensureOfficeCli(assistant) {
  const expected = await buildExpectedOfficeCli();
  const officeCli = assistant.cliPath;
  if (await pathEntryExists(officeCli)) {
    if (!(await fileExistsRegular(officeCli))) throw new Error("generated office CLI is not a regular file");
    const current = await readFile(officeCli, "utf8");
    const currentHash = sha256(current);
    const expectedHash = sha256(expected);
    if (currentHash === expectedHash) return officeCli;
    throw new Error("generated office CLI copy changed; refusing to run");
  }
  await writeTextAtomic(officeCli, expected);
  return officeCli;
}

async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readPidMetadata(assistant) {
  if (!(await fileExistsRegular(assistant.pidFile))) return null;
  const metadata = JSON.parse(await readFile(assistant.pidFile, "utf8"));
  if (metadata?.schemaVersion !== 1 || metadata?.assistantName !== assistant.key ||
      metadata?.profile !== assistant.profile || !Number.isInteger(metadata?.pid) || metadata.pid < 1 ||
      !samePath(metadata.nodePath, process.execPath) ||
      !samePath(metadata.bridgeHome, assistant.bridgeHome) ||
      !samePath(metadata.codexHome, assistant.codexHome) ||
      !samePath(metadata.workspace, assistant.workspace) ||
      !samePath(metadata.cliPath, assistant.cliPath) ||
      !samePath(metadata.configPath, assistant.profileConfigPath)) {
    throw new Error("office process metadata does not match the fixed assistant mapping");
  }
  return metadata;
}

function runPowerShellProbe(payload, timeoutMs = 4_000) {
  return new Promise((resolveProbe) => {
    let child;
    let output = "";
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe(value);
    };
    try {
      child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROCESS_PROBE], {
        windowsHide: true,
        env: systemEnvironment(),
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(null);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(output, "utf8") + Buffer.byteLength(chunk, "utf8") > MAX_CAPTURE_BYTES) {
        try { child.kill(); } catch {}
        finish(null);
        return;
      }
      output += chunk;
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      try {
        const result = JSON.parse(output);
        if (result?.pid !== payload.pid || typeof result.alive !== "boolean" || typeof result.verified !== "boolean" ||
            typeof result.pathMatches !== "boolean" || typeof result.commandMatches !== "boolean" ||
            typeof result.ownerMatches !== "boolean") {
          finish(null);
          return;
        }
        finish({
          pid: result.pid,
          alive: result.alive,
          verified: result.verified,
          pathMatches: result.pathMatches,
          commandMatches: result.commandMatches,
          ownerMatches: result.ownerMatches,
        });
      } catch {
        finish(null);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

async function inspectOfficeProcess(metadata, assistant) {
  return runPowerShellProbe({
    pid: metadata.pid,
    nodePath: metadata.nodePath,
    cliPath: assistant.cliPath,
    configPath: assistant.profileConfigPath,
    profile: assistant.profile,
  });
}

function safeChildCode(code) {
  const value = typeof code === "string" ? code : "unknown";
  return /^[A-Z0-9_]{1,32}$/.test(value) ? value : "other";
}

function startupFailureCategory({ spawnErrorCode, childExitCode, childExitedBySignal, processState }) {
  if (spawnErrorCode) return `spawn-${spawnErrorCode}`;
  if (Number.isInteger(childExitCode)) return `child-exit-${childExitCode}`;
  if (childExitedBySignal) return "child-terminated-before-verification";
  if (!processState) return "process-metadata-probe-failed";
  if (!processState.alive) return "child-not-found";
  if (!processState.pathMatches) return "node-image-path-mismatch";
  if (!processState.commandMatches) return "office-commandline-mismatch";
  if (!processState.ownerMatches) return "windows-owner-sid-mismatch";
  return "startup-verification-timeout";
}

function metadataFor(assistant, cliPath, pid) {
  return {
    schemaVersion: 1,
    assistantName: assistant.name,
    profile: assistant.profile,
    pid,
    nodePath: process.execPath,
    cliPath,
    configPath: assistant.profileConfigPath,
    bridgeHome: assistant.bridgeHome,
    codexHome: assistant.codexHome,
    workspace: assistant.workspace,
    startedAt: new Date().toISOString(),
  };
}

function runtimeEnvironment(assistant) {
  return {
    ...systemEnvironment(),
    FEISHU_CODEX_HOME: DATA_ROOT,
    FEISHU_CODEX_CONFIG: CONFIG_PATH,
    FEISHU_CODEX_NODE: process.execPath,
    FEISHU_CODEX_BRIDGE_CLI: STOCK_CLI,
    LARK_OFFICE_RUNTIME: "1",
    LARK_OFFICE_ASSISTANT: assistant.name,
    LARK_OFFICE_ASSISTANT_FILE: assistant.assistantFile,
    LARK_CHANNEL_HOME: assistant.bridgeHome,
    LARK_CHANNEL_PROFILE: assistant.profile,
    CODEX_HOME: assistant.codexHome,
  };
}

function systemEnvironment() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const nodeDirectory = dirname(process.execPath);
  const pathEntries = [
    nodeDirectory,
    join(systemRoot, "System32"),
    systemRoot,
    join(systemRoot, "System32", "Wbem"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
  ];
  const env = {};
  for (const key of [
    "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS", "OS", "USERDOMAIN", "USERNAME",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "SystemDrive",
  ]) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  env.PATH = [...new Set(pathEntries)].join(";");
  env.FEISHU_CODEX_HOME = DATA_ROOT;
  env.FEISHU_CODEX_CONFIG = CONFIG_PATH;
  return env;
}

function taskStopMarker(assistant) {
  return join(assistant.bridgeHome, ".office-runtime.stop-requested");
}

function expectedTaskName(assistant) {
  return `FeishuOffice-${TASK_NAMESPACE}-${assistant.key}`;
}

function runTaskController(action, assistant, timeoutMs = action === "stop" ? 45_000 : 20_000) {
  return new Promise((resolveTask) => {
    let child;
    let output = "";
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveTask(value);
    };
    try {
      child = spawn("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", TASK_CONTROLLER, action, assistant.key,
        "-OfficeRoot", officeRoot(), "-RuntimeRoot", RUNTIME_DIR,
        "-NodePath", isAbsolute(toolPath("node")) ? toolPath("node") : process.execPath,
        "-DataRoot", DATA_ROOT, "-ConfigPath", CONFIG_PATH,
        "-TaskNamespace", TASK_NAMESPACE,
      ], {
        windowsHide: true,
        env: systemEnvironment(),
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(null);
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(output, "utf8") + Buffer.byteLength(chunk, "utf8") > MAX_CAPTURE_BYTES) {
        try { child.kill(); } catch {}
        finish(null);
        return;
      }
      output += chunk;
    });
    child.once("error", () => finish(null));
    child.once("close", () => {
      try {
        const result = JSON.parse(output.trim());
        if (result?.schemaVersion !== 1 || result?.action !== action || result?.assistantKey !== assistant.key ||
            result?.taskName !== expectedTaskName(assistant) || typeof result.ok !== "boolean" ||
            typeof result.enabled !== "boolean" || typeof result.autostartDisabled !== "boolean" ||
            typeof result.sidMatches !== "boolean" || typeof result.state !== "string") {
          finish(null);
          return;
        }
        finish(result);
      } catch {
        finish(null);
      }
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(null);
    }, timeoutMs);
  });
}

async function appendServiceLog(handle, message) {
  if (!handle) return;
  await handle.writeFile(`${new Date().toISOString()} ${message}\n`, "utf8").catch(() => {});
}

async function stopVerifiedChild(metadata, assistant) {
  const before = await inspectOfficeProcess(metadata, assistant);
  if (!before) return { ok: false, errorCode: "process-identity-unverified" };
  if (!before.alive) {
    const current = await readPidMetadata(assistant).catch(() => null);
    if (current?.pid === metadata.pid) await unlink(assistant.pidFile).catch(() => {});
    return { ok: true, stopped: false };
  }
  if (!before.verified) return { ok: false, errorCode: "pid-identity-mismatch" };
  try {
    process.kill(metadata.pid, "SIGTERM");
  } catch {
    return { ok: false, errorCode: "verified-process-signal-failed" };
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    const after = await inspectOfficeProcess(metadata, assistant);
    if (after && !after.alive) {
      const current = await readPidMetadata(assistant).catch(() => null);
      if (current?.pid === metadata.pid) await unlink(assistant.pidFile).catch(() => {});
      return { ok: true, stopped: true };
    }
    if (after?.alive && !after.verified) return { ok: false, errorCode: "pid-identity-changed" };
  }
  return { ok: false, errorCode: "verified-process-stop-timeout" };
}

function showSetupInstruction(assistant) {
  console.log(`${assistant.name} has not passed its explicit enablement and identity checks.`);
  console.log("Complete the private credential and identity setup first; no assistant process was started.");
  console.log(`Profile-local Lark CLI auth config: ${assistant.profileCliConfigPath}`);
}

async function status(name) {
  let assistant;
  try {
    assistant = loadOfficeAssistant(name);
  } catch {
    console.error("Assistant configuration does not match the local project binding.");
    process.exitCode = 2;
    return;
  }
  console.log(`Assistant: ${assistant.displayName} (${assistant.key})`);
  console.log(`Profile: ${assistant.profile}`);
  console.log(`Enabled: ${assistant.enabled}`);
  console.log(`Identity verified: ${assistant.identityVerified}`);
  console.log(`Allowed user configured: ${Boolean(assistant.allowedOpenId)}`);
  console.log(`Bridge home: ${assistant.bridgeHome}`);
  console.log(`Codex home: ${assistant.codexHome}`);
  console.log(`Workspace: ${assistant.workspace}`);
  console.log(`Profile-local Lark CLI auth config: ${assistant.profileCliConfigPath}`);
  console.log(`Profile config present: ${await fileExistsRegular(assistant.profileConfigPath)}`);
  const task = await runTaskController("status", assistant);
  console.log(`Scheduled Task: ${task?.ok ? `${task.state} (enabled=${task.enabled}, current SID=${task.sidMatches})` : "unavailable or unverified"}`);
  if (!assistant.ready) showSetupInstruction(assistant);
}

async function checkReady(name) {
  try {
    const assistant = await readAssistantForStart(name);
    if (!assistant) process.exitCode = 3;
  } catch {
    process.exitCode = 2;
  }
}

async function serve(name) {
  let assistant;
  let cliPath;
  try {
    assistant = await readAssistantForStart(name);
  } catch {
    console.error("Assistant configuration is invalid; service was not started.");
    process.exitCode = 2;
    return;
  }
  if (!assistant) {
    process.exitCode = 0;
    return;
  }

  let serviceLog;
  let stdoutLog;
  let stderrLog;
  try {
    try {
      cliPath = await ensureOfficeCli(assistant);
    } catch {
      process.exitCode = 6;
      return;
    }

    const previous = await readPidMetadata(assistant).catch(() => null);
    if (previous) {
      const state = await inspectOfficeProcess(previous, assistant);
      if (state === null || (state.alive && !state.verified)) {
        console.error("Existing process identity could not be verified; service refused to replace it.");
        process.exitCode = 5;
        return;
      }
      if (state.alive && state.verified) {
        const stopped = await stopVerifiedChild(previous, assistant);
        if (!stopped.ok) {
          console.error("Verified prior office process could not be safely replaced.");
          process.exitCode = 5;
          return;
        }
      } else {
        await unlink(assistant.pidFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
      }
    } else if (await pathEntryExists(assistant.pidFile)) {
      console.error("Existing process metadata is malformed; service refused to replace it.");
      process.exitCode = 5;
      return;
    }

    const logDirectory = join(assistant.bridgeHome, "office-runtime-logs");
    const logDirectoryStat = await lstat(logDirectory).catch(() => null);
    if (!logDirectoryStat?.isDirectory() || logDirectoryStat.isSymbolicLink()) {
      console.error("Private service log directory is not prepared; service was not started.");
      process.exitCode = 7;
      return;
    }
    serviceLog = await open(join(logDirectory, "supervisor.log"), "a", 0o600);
    stdoutLog = await open(join(logDirectory, "office-cli.stdout.log"), "a", 0o600);
    stderrLog = await open(join(logDirectory, "office-cli.stderr.log"), "a", 0o600);
    await appendServiceLog(serviceLog, "serve-start");

    const args = [cliPath, "run", "--profile", assistant.profile, "--config", assistant.profileConfigPath];
    const child = spawn(process.execPath, args, {
      cwd: assistant.workspace,
      env: runtimeEnvironment(assistant),
      detached: false,
      windowsHide: true,
      stdio: ["ignore", stdoutLog.fd, stderrLog.fd],
    });
    let spawnErrorCode = null;
    child.once("error", (error) => { spawnErrorCode = safeChildCode(error?.code); });
    const childExit = new Promise((resolveExit) => {
      child.once("close", (code, signal) => resolveExit({ code: Number.isInteger(code) ? code : null, signal }));
    });
    try {
      await new Promise((resolveSpawn, rejectSpawn) => {
        child.once("spawn", resolveSpawn);
        child.once("error", rejectSpawn);
      });
    } catch {
      await appendServiceLog(serviceLog, `child-spawn-failed:${spawnErrorCode ?? "unknown"}`);
      process.exitCode = 8;
      return;
    }

    const metadata = metadataFor(assistant, cliPath, child.pid);
    let verified = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const currentState = await inspectOfficeProcess(metadata, assistant);
      if (currentState?.alive && currentState.verified) {
        verified = true;
        break;
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    if (!verified) {
      try { child.kill(); } catch {}
      await appendServiceLog(serviceLog, "child-identity-verification-failed");
      process.exitCode = 8;
      return;
    }
    await writeJsonAtomic(assistant.pidFile, metadata);
    await appendServiceLog(serviceLog, `child-verified:${metadata.pid}`);

    const result = await childExit;
    const current = await readPidMetadata(assistant).catch(() => null);
    if (current?.pid === metadata.pid) await unlink(assistant.pidFile).catch(() => {});
    const stopRequested = await pathEntryExists(taskStopMarker(assistant)).catch(() => false);
    await appendServiceLog(serviceLog, `child-exit:${result.code ?? "signal"}`);
    if (stopRequested) process.exitCode = 0;
    else process.exitCode = result.code === 0 ? 10 : result.code ?? 11;
  } catch {
    await appendServiceLog(serviceLog, "serve-failed");
    process.exitCode = 9;
  } finally {
    await serviceLog?.close().catch(() => {});
    await stdoutLog?.close().catch(() => {});
    await stderrLog?.close().catch(() => {});
  }
}

async function readAssistantForStart(name) {
  const assistant = loadOfficeAssistant(name);
  if (!assistant.ready) {
    showSetupInstruction(assistant);
    return null;
  }
  if (!(await fileExistsRegular(assistant.profileConfigPath))) {
    console.log("The exact office profile has not been initialized yet.");
    console.log(`Complete the private credential setup at: ${assistant.profileCliConfigPath}`);
    return null;
  }
  return assistant;
}

async function start(name) {
  let assistant;
  try {
    assistant = await readAssistantForStart(name);
  } catch {
    console.error("Assistant configuration is invalid; no process was started.");
    process.exitCode = 2;
    return;
  }
  if (!assistant) {
    process.exitCode = 3;
    return;
  }

  const lock = await open(assistant.lockFile, "wx", 0o600).catch(() => null);
  if (!lock) {
    console.error("An office start or stop operation is already in progress.");
    process.exitCode = 4;
    return;
  }

  try {
    const taskBefore = await runTaskController("status", assistant);
    if (!taskBefore?.ok || !taskBefore.sidMatches) {
      console.error("Scheduled Task identity could not be verified; no process was started.");
      process.exitCode = 4;
      return;
    }
    const previous = await readPidMetadata(assistant).catch(() => null);
    if (previous) {
      const state = await inspectOfficeProcess(previous, assistant);
      if (state?.alive && state.verified && taskBefore.exists && taskBefore.enabled && taskBefore.state === "Running") {
        console.log(`${assistant.name} is already running (PID ${previous.pid}).`);
        return;
      }
      if (state === null) {
        console.error("Existing process metadata could not be verified; refusing to replace it.");
        process.exitCode = 5;
        return;
      }
      if (state.alive && !state.verified) {
        console.error("Existing PID does not match this office runtime; refusing to stop or replace it.");
        process.exitCode = 5;
        return;
      }
      if (!state.alive) await unlink(assistant.pidFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
    } else if (await pathEntryExists(assistant.pidFile)) {
      console.error("Existing process metadata is malformed; refusing to replace it.");
      process.exitCode = 5;
      return;
    }

    let cliPath;
    try {
      cliPath = await ensureOfficeCli(assistant);
    } catch {
      console.error("Stock bridge verification or office patch verification failed; no process was started.");
      process.exitCode = 6;
      return;
    }

    await unlink(taskStopMarker(assistant)).catch(() => {});
    const taskStartAttemptAt = Date.now();
    const taskStart = await runTaskController("start", assistant);
    if (!taskStart?.ok || !taskStart.enabled || !taskStart.sidMatches) {
      console.error(`Scheduled Task start failed (${taskStart?.errorCode ?? "controller-unavailable"}); no PID was reported.`);
      process.exitCode = 7;
      return;
    }
    let lastProcessState = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      let metadata = null;
      try {
        metadata = await readPidMetadata(assistant);
      } catch {
        console.error("Office PID metadata is malformed; refusing to attach to a process.");
        process.exitCode = 8;
        return;
      }
      if (metadata) {
        lastProcessState = await inspectOfficeProcess(metadata, assistant);
        const childStartedAt = Date.parse(metadata.startedAt);
        if (lastProcessState?.alive && lastProcessState.verified && Number.isFinite(childStartedAt) && childStartedAt >= taskStartAttemptAt - 2_000) {
          const activeTask = await runTaskController("status", assistant);
          if (activeTask?.ok && activeTask.enabled && activeTask.state === "Running" && activeTask.sidMatches) {
            console.log(`${assistant.name} is running under its current-user Scheduled Task (PID ${metadata.pid}).`);
            return;
          }
        }
        if (lastProcessState?.alive && !lastProcessState.verified) {
          console.error("Office PID identity changed during startup; refusing to continue.");
          process.exitCode = 8;
          return;
        }
      }
      if (attempt % 8 === 7) {
        const activeTask = await runTaskController("status", assistant);
        if (!activeTask?.ok || !activeTask.enabled || !activeTask.sidMatches) {
          console.error("Scheduled Task stopped or lost its user binding before the office child was verified.");
          process.exitCode = 8;
          return;
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    console.error(`Office task startup could not verify its child (${startupFailureCategory({ processState: lastProcessState })}).`);
    process.exitCode = 8;
  } finally {
    await lock.close().catch(() => {});
    await unlink(assistant.lockFile).catch(() => {});
  }
}

async function stop(name) {
  let assistant;
  try {
    assistant = loadOfficeAssistant(name);
  } catch {
    console.error("Assistant configuration does not match the local project binding.");
    process.exitCode = 2;
    return;
  }
  const lock = await open(assistant.lockFile, "wx", 0o600).catch(() => null);
  if (!lock) {
    console.error("An office start or stop operation is already in progress.");
    process.exitCode = 4;
    return;
  }
  const stopMarker = taskStopMarker(assistant);
  let removeStopMarker = false;
  try {
    await writeTextAtomic(stopMarker, `${new Date().toISOString()}\n`);
    const taskStop = await runTaskController("stop", assistant);
    if (!taskStop?.autostartDisabled) {
      await unlink(stopMarker).catch(() => {});
      console.error(`Scheduled Task autostart could not be disabled (${taskStop?.errorCode ?? "controller-unavailable"}); process was left untouched.`);
      process.exitCode = 4;
      return;
    }
    removeStopMarker = taskStop.ok;
    let metadata;
    try {
      metadata = await readPidMetadata(assistant);
    } catch {
      console.error("PID metadata does not match this assistant; refusing to stop a process.");
      process.exitCode = 5;
      return;
    }
    if (!metadata) {
      if (taskStop.ok) console.log(`${assistant.name} has no remaining managed process.`);
      else {
        console.error(`Autostart was disabled, but the Scheduled Task stop needs follow-up (${taskStop.errorCode ?? "task-stop-failed"}).`);
        process.exitCode = 7;
      }
      return;
    }
    const before = await inspectOfficeProcess(metadata, assistant);
    if (!before) {
      console.error("Process identity could not be verified; refusing to stop it.");
      process.exitCode = 5;
      return;
    }
    if (!before.alive) {
      await unlink(assistant.pidFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
      if (taskStop.ok) console.log(`${assistant.name} is already stopped.`);
      else {
        console.error(`Autostart was disabled, but the Scheduled Task stop needs follow-up (${taskStop.errorCode ?? "task-stop-failed"}).`);
        process.exitCode = 7;
      }
      return;
    }
    if (!before.verified) {
      console.error("PID belongs to another process; refusing to stop it.");
      process.exitCode = 5;
      return;
    }
    try {
      process.kill(metadata.pid, "SIGTERM");
    } catch {
      console.error("Verified office process could not be signaled.");
      process.exitCode = 6;
      return;
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      const after = await inspectOfficeProcess(metadata, assistant);
      if (after && !after.alive) {
        await unlink(assistant.pidFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
        if (taskStop.ok) console.log(`${assistant.name} stopped.`);
        else {
          console.error(`Office child stopped; Scheduled Task is not confirmed stopped (${taskStop.errorCode ?? "task-stop-failed"}).`);
          process.exitCode = 7;
        }
        return;
      }
      if (after?.alive && !after.verified) {
        console.error("PID identity changed while stopping; PID metadata was retained.");
        process.exitCode = 5;
        return;
      }
    }
    console.error("Verified office process did not stop before the timeout; PID metadata was retained.");
    process.exitCode = 7;
  } finally {
    if (removeStopMarker) await unlink(stopMarker).catch(() => {});
    await lock.close().catch(() => {});
    await unlink(assistant.lockFile).catch(() => {});
  }
}

async function prepare() {
  const key = process.argv[3];
  if (!key) {
    console.error("Provide an assistant key so the generated runtime copy stays beneath that assistant's private data directory.");
    process.exitCode = 2;
    return;
  }
  try {
    const assistant = loadOfficeAssistant(key);
    const cli = await ensureOfficeCli(assistant);
    console.log(`Verified office CLI runtime copy is ready for ${assistant.displayName} (${assistant.key}).`);
  } catch (error) {
    console.error(`Stock bridge verification or office patch verification failed (${safePrepareReason(error)}).`);
    process.exitCode = 6;
  }
}

async function taskInstall(key) {
  let assistant;
  try { assistant = loadOfficeAssistant(key); }
  catch {
    console.error("Assistant configuration does not match the local project binding; task was not registered.");
    process.exitCode = 2;
    return;
  }
  const result = await runTaskController("register-disabled", assistant);
  if (!result?.ok || !result.exists || result.enabled || !result.autostartDisabled || !result.sidMatches) {
    console.error(`Logon task registration was not verified (${result?.errorCode ?? "controller-unavailable"}).`);
    process.exitCode = 4;
    return;
  }
  console.log(`Registered disabled current-user logon task ${result.taskName}; no assistant process was started.`);
}

function safePrepareReason(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  const patch = message.match(/^stock patch anchor mismatch: ([A-Za-z0-9:_-]{1,80})$/);
  if (patch) return `patch-${patch[1]}`;
  if (message.includes("version does not match")) return "version-pin";
  if (message.includes("source hash does not match")) return "source-hash-pin";
  if (message.includes("generated office CLI copy changed")) return "generated-copy-hash";
  if (message.includes("generated office CLI is not a regular file")) return "generated-copy-type";
  if (message.includes("Cannot find module") || message.includes("MODULE_NOT_FOUND")) return "dependency-resolution";
  return "unexpected-source";
}

async function main() {
  const [command, name] = process.argv.slice(2);
  if (command === "status" && name) return status(name);
  if (command === "start" && name) return start(name);
  if (command === "stop" && name) return stop(name);
  if (command === "serve" && name) return serve(name);
  if (command === "check-ready" && name) return checkReady(name);
  if (command === "task-install" && name) return taskInstall(name);
  if (command === "prepare" && name) return prepare();
  usage();
  process.exitCode = 2;
}

main().catch(() => {
  console.error("Office runtime failed closed; no assistant was started or stopped.");
  process.exitCode = 9;
});
