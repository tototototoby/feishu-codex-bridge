import { access, lstat, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { isAbsolute, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { spawnSync } from 'node:child_process';
import { loadProjectConfig, officeRoot, safeAssistantSegment, toolPath, upstreamRoot } from '../settings.mjs';

const NODE_MODULES = upstreamRoot();
const MAX_SECRET_BYTES = 4096;

function report(status, attempted = false, credentialValidated = null, encryptedProfileSaved = null) {
  const safeStatuses = new Set([
    'saved',
    'validation-failed',
    'profile-exists',
    'codex-unavailable',
    'config-invalid',
    'input-rejected',
    'failed',
  ]);
  const safeStatus = safeStatuses.has(status) ? status : 'failed';
  try {
    writeSync(1, `${JSON.stringify({
      status: safeStatus,
      attempted: attempted === true,
      credentialValidated: credentialValidated === true ? true : credentialValidated === false ? false : null,
      encryptedProfileSaved: encryptedProfileSaved === true ? true : encryptedProfileSaved === false ? false : null,
    })}\n`);
  } catch {
    // The parent window parses only this fixed status record.
  }
}

async function readSecretFromStdin() {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_SECRET_BYTES + 2) {
      buffer.fill(0);
      for (const previous of chunks) previous.fill(0);
      chunks.length = 0;
      return null;
    }
    chunks.push(buffer);
  }
  const input = Buffer.concat(chunks, totalBytes);
  for (const chunk of chunks) chunk.fill(0);
  chunks.length = 0;
  if (input.length > 0 && input[input.length - 1] === 0x0a) {
    const end = input.length - 1;
    const bodyEnd = end > 0 && input[end - 1] === 0x0d ? end - 1 : end;
    const secretBytes = input.subarray(0, bodyEnd);
    if (secretBytes.length === 0 || secretBytes.length > MAX_SECRET_BYTES) {
      input.fill(0);
      return null;
    }
    try {
      const secret = new TextDecoder('utf-8', { fatal: true }).decode(secretBytes);
      if (!secret || secret.length > 1024 || /[\u0000-\u001f\u007f]/u.test(secret)) {
        input.fill(0);
        return null;
      }
      return { secret, input };
    } catch {
      input.fill(0);
      return null;
    }
  }
  input.fill(0);
  return null;
}

function configuredAssistant(key) {
  const assistantKey = safeAssistantSegment(key);
  const project = loadProjectConfig({ required: true });
  const definition = project.assistants?.[assistantKey];
  if (!definition || typeof definition.appId !== 'string' || !/^cli_[A-Za-z0-9_-]{8,128}$/.test(definition.appId) ||
      typeof definition.intendedUserEmail !== 'string' || !definition.intendedUserEmail.trim() ||
      typeof definition.expectedTenantKey !== 'string' || !definition.expectedTenantKey.trim()) throw new Error('configuration mismatch');
  return {
    ...definition,
    key: assistantKey,
    dir: safeAssistantSegment(definition.directory || assistantKey),
    profile: safeAssistantSegment(definition.profile || assistantKey),
    tenant: 'feishu',
  };
}

async function resolveExecutable(specification) {
  if (typeof specification !== 'string' || !specification.trim()) throw new Error('executable unavailable');
  if (isAbsolute(specification)) {
    await access(specification, fsConstants.F_OK);
    return realpath(specification);
  }
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(lookup, [specification], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.error || result.status !== 0) throw new Error('executable unavailable');
  for (const line of String(result.stdout).split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    if (!isAbsolute(line)) continue;
    try { await access(line, fsConstants.F_OK); return await realpath(line); } catch {}
  }
  throw new Error('executable unavailable');
}

async function loadFixedConfiguration(app) {
  const assistantRoot = resolve(officeRoot(), app.dir);
  const configPath = join(assistantRoot, 'assistant.json');
  const configStat = await lstat(configPath);
  if (!configStat.isFile() || configStat.isSymbolicLink()) throw new Error('configuration mismatch');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const bridgeHome = resolve(String(config.bridgeHome ?? ''));
  const codexHome = resolve(String(config.codexHome ?? ''));
  const workspace = resolve(String(config.workspace ?? ''));
  const identityVerificationMethod = app.identityVerificationMethod || 'oauth-enterprise-email';
  const expectedUserUnionId = app.expectedUserUnionId || null;
  const expected = {
    appId: app.appId,
    profile: app.profile,
    tenant: app.tenant,
    bridgeHome: resolve(assistantRoot, 'bridge'),
    codexHome: resolve(assistantRoot, 'codex'),
    workspace: resolve(assistantRoot, 'workspace'),
  };
  const samePath = (left, right) => left.toLowerCase() === right.toLowerCase();
  if (config.appId !== expected.appId || config.profile !== expected.profile || config.tenant !== expected.tenant ||
      config.intendedUserEmail?.trim().toLowerCase() !== app.intendedUserEmail.trim().toLowerCase() ||
      config.expectedTenantKey !== app.expectedTenantKey || config.allowGroupMessages !== false ||
      config.identityVerificationMethod !== identityVerificationMethod || config.expectedUserUnionId !== expectedUserUnionId ||
      !samePath(bridgeHome, expected.bridgeHome) || !samePath(codexHome, expected.codexHome) ||
      !samePath(workspace, expected.workspace)) {
    throw new Error('configuration mismatch');
  }
  for (const path of [bridgeHome, codexHome, workspace]) {
    const actual = await realpath(path);
    if (!samePath(actual, path)) throw new Error('path mismatch');
  }
  return { assistantRoot, assistantConfigPath: configPath, bridgeHome, codexHome, workspace, config, identityVerificationMethod, expectedUserUnionId };
}

async function saveCodexBinaryBinding(context, app, codexBinary) {
  const configStat = await lstat(context.assistantConfigPath);
  if (!configStat.isFile() || configStat.isSymbolicLink()) throw new Error('configuration changed during profile setup');
  const latest = JSON.parse(await readFile(context.assistantConfigPath, 'utf8'));
  if (latest.appId !== app.appId || latest.profile !== app.profile || latest.tenant !== 'feishu' ||
      !samePath(latest.bridgeHome, context.bridgeHome) || !samePath(latest.codexHome, context.codexHome) ||
      !samePath(latest.workspace, context.workspace) || latest.allowGroupMessages !== false) throw new Error('configuration changed during profile setup');
  const temporary = `${context.assistantConfigPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...latest, codexBinaryPath: codexBinary }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, context.assistantConfigPath);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function captureCliOutput() {
  const flags = {
    credentialValidated: false,
    credentialRejected: false,
    profileCreated: false,
    profileExists: false,
    codexUnavailable: false,
  };
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const originalExit = process.exit;
  const originalArgv = process.argv;
  const inspect = (chunk) => {
    let text = '';
    if (typeof chunk === 'string') text = chunk;
    else if (Buffer.isBuffer(chunk)) text = chunk.toString('utf8');
    else if (ArrayBuffer.isView(chunk)) text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
    if (text.includes('应用凭证校验通过')) flags.credentialValidated = true;
    if (text.includes('app credentials validation failed')) flags.credentialRejected = true;
    if (text.includes('已创建 profile:')) flags.profileCreated = true;
    if (text.includes('profile already exists')) flags.profileExists = true;
    if (text.includes('agent-binary-not-found') || text.includes('executable not found:')) flags.codexUnavailable = true;
  };
  const discardWrite = function (chunk, encoding, callback) {
    inspect(chunk);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') queueMicrotask(() => done(null));
    return true;
  };
  process.stdout.write = discardWrite;
  process.stderr.write = discardWrite;
  process.exit = (code = 0) => { process.exitCode = Number.isInteger(code) ? code : 0; };
  return {
    flags,
    original: { stdoutWrite, stderrWrite, exit: originalExit, argv: originalArgv },
    restore() {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
      process.exit = originalExit;
      process.argv = originalArgv;
    },
  };
}

async function createProfile(app) {
  let secretRecord = null;
  let secret = null;
  let instrumentation = null;
  let commandPromise = null;
  let commandPrototype = null;
  let originalParseAsync = null;
  let exitCodeBefore = process.exitCode;
  let reportStatus = 'failed';
  let attempted = false;
  let credentialValidated = null;
  let encryptedProfileSaved = null;
  let fixedConfig = null;
  let codexBinary = null;
  const originalEnvironment = {
    LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    LARK_CHANNEL_CODEX_BIN: process.env.LARK_CHANNEL_CODEX_BIN,
  };

  try {
    secretRecord = await readSecretFromStdin();
    if (!secretRecord) {
      return { status: 'input-rejected', attempted: false, credentialValidated: null, encryptedProfileSaved: false };
    }
    secret = secretRecord.secret;

    const config = await loadFixedConfiguration(app);
    fixedConfig = config;
    const packagePath = join(NODE_MODULES, 'package.json');
    const cliPath = join(NODE_MODULES, 'dist', 'cli.js');
    codexBinary = await resolveExecutable(toolPath('codex'));
    const packageMetadata = JSON.parse(await readFile(packagePath, 'utf8'));
    if (packageMetadata.name !== 'lark-channel-bridge' || packageMetadata.version !== '0.7.1') {
      return { status: 'config-invalid', attempted: false, credentialValidated: null, encryptedProfileSaved: false };
    }
    await access(cliPath, fsConstants.F_OK);
    try {
      await access(codexBinary, fsConstants.X_OK);
    } catch {
      return { status: 'codex-unavailable', attempted: false, credentialValidated: null, encryptedProfileSaved: false };
    }
    if (!(await stat(config.workspace)).isDirectory()) {
      return { status: 'config-invalid', attempted: false, credentialValidated: null, encryptedProfileSaved: false };
    }

    const existingPaths = [
      join(config.bridgeHome, 'config.json'),
      join(config.bridgeHome, 'profiles'),
    ];
    for (const existingPath of existingPaths) {
      if (await pathExists(existingPath)) {
        return { status: 'profile-exists', attempted: false, credentialValidated: null, encryptedProfileSaved: false };
      }
    }

    process.env.LARK_CHANNEL_HOME = config.bridgeHome;
    process.env.CODEX_HOME = config.codexHome;
    process.env.LARK_CHANNEL_CODEX_BIN = codexBinary;
    instrumentation = captureCliOutput();
    process.argv = [
      process.execPath,
      cliPath,
      'profile', 'create', app.profile,
      '--agent', 'codex',
      '--workspace', config.workspace,
      '--app-id', app.appId,
      '--app-secret', secret,
      '--tenant', app.tenant,
    ];

    const cliRequire = createRequire(cliPath);
    const commanderRequirePath = cliRequire.resolve('commander');
    const commanderEsmPath = join(dirname(commanderRequirePath), 'esm.mjs');
    const { Command } = await import(pathToFileURL(commanderEsmPath).href);
    commandPrototype = Command.prototype;
    originalParseAsync = commandPrototype.parseAsync;
    commandPrototype.parseAsync = function (...args) {
      commandPromise = originalParseAsync.apply(this, args);
      return commandPromise;
    };

    attempted = true;
    await import(pathToFileURL(cliPath).href);
    if (!commandPromise) {
      reportStatus = 'failed';
    } else {
      await commandPromise.then(() => undefined, () => undefined);
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      const flags = instrumentation.flags;
      if (flags.credentialValidated) credentialValidated = true;
      else if (flags.credentialRejected) credentialValidated = false;
      if (flags.profileExists) {
        reportStatus = 'profile-exists';
        encryptedProfileSaved = false;
      } else if (flags.credentialRejected) {
        reportStatus = 'validation-failed';
        encryptedProfileSaved = false;
      } else if (flags.codexUnavailable && !flags.credentialValidated) {
        reportStatus = 'codex-unavailable';
        encryptedProfileSaved = false;
      } else if (flags.profileCreated && flags.credentialValidated && process.exitCode === exitCodeBefore) {
        reportStatus = 'saved';
        encryptedProfileSaved = true;
        await saveCodexBinaryBinding(fixedConfig, app, codexBinary);
      } else {
        reportStatus = 'failed';
      }
    }
  } catch {
    reportStatus = 'failed';
  } finally {
    if (commandPrototype && originalParseAsync) commandPrototype.parseAsync = originalParseAsync;
    if (instrumentation) instrumentation.restore();
    process.exitCode = exitCodeBefore;
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (secretRecord?.input) secretRecord.input.fill(0);
    secret = null;
  }

  return { status: reportStatus, attempted, credentialValidated, encryptedProfileSaved };
}

async function main() {
  const appName = process.argv[2];
  let app;
  try { app = configuredAssistant(appName); } catch {
    report('config-invalid', false, null, false);
    process.exitCode = 2;
    return;
  }
  try {
    const result = await createProfile(app);
    report(result.status, result.attempted, result.credentialValidated, result.encryptedProfileSaved);
    process.exitCode = result.status === 'saved' ? 0 : 1;
  } catch {
    report('failed', false, null, null);
    process.exitCode = 1;
  }
}

await main();
