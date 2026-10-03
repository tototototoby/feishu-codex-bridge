import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'cross-spawn';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadProjectConfig, officeRoot, safeAssistantSegment, toolPath, upstreamRoot } from '../settings.mjs';

const SAME_PATH = (a, b) => resolve(a).replaceAll('/', '\\').toLowerCase() === resolve(b).replaceAll('/', '\\').toLowerCase();
const APP_ID_RE = /^cli_[A-Za-z0-9_-]{8,128}$/;
const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{8,128}$/;
const UNION_ID_RE = /^on_[A-Za-z0-9_-]{8,128}$/;
const NODE_PATH = process.execPath;
const BRIDGE_ROOT = upstreamRoot();
const BRIDGE_PACKAGE = join(BRIDGE_ROOT, 'package.json');
const BRIDGE_CLI = join(BRIDGE_ROOT, 'dist', 'cli.js');

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function loadAssistant(key) {
  const safeKey = safeAssistantSegment(key);
  const project = loadProjectConfig({ required: true });
  const definition = project.assistants?.[safeKey];
  if (!definition || typeof definition !== 'object' || !APP_ID_RE.test(definition.appId ?? '') ||
      typeof definition.intendedUserEmail !== 'string' || !definition.intendedUserEmail.trim() ||
      typeof definition.expectedTenantKey !== 'string' || !definition.expectedTenantKey.trim()) throw new Error('unknown-assistant');
  const directory = safeAssistantSegment(definition.directory || safeKey);
  const profile = safeAssistantSegment(definition.profile || safeKey);
  const verificationMethod = definition.identityVerificationMethod || 'oauth-enterprise-email';
  const expectedUnionId = definition.expectedUserUnionId || null;
  if (!['oauth-enterprise-email', 'oauth-union-id'].includes(verificationMethod) ||
      (verificationMethod === 'oauth-union-id' && !UNION_ID_RE.test(expectedUnionId ?? ''))) throw new Error('expected-identity-missing');
  const assistantDirectory = join(officeRoot(), directory);
  const configPath = join(assistantDirectory, 'assistant.json');
  const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
  if (config.appId !== definition.appId || config.profile !== profile || config.tenant !== 'feishu' ||
      config.expectedTenantKey !== definition.expectedTenantKey ||
      config.intendedUserEmail?.trim().toLowerCase() !== definition.intendedUserEmail.trim().toLowerCase() ||
      config.identityVerificationMethod !== verificationMethod || config.expectedUserUnionId !== expectedUnionId ||
      config.allowGroupMessages !== false || !SAME_PATH(config.bridgeHome, join(assistantDirectory, 'bridge')) ||
      !SAME_PATH(config.codexHome, join(assistantDirectory, 'codex')) || !SAME_PATH(config.workspace, join(assistantDirectory, 'workspace'))) {
    throw new Error('config-mismatch');
  }
  for (const path of [config.bridgeHome, config.codexHome, config.workspace]) {
    if (!SAME_PATH(await realpath(path), path)) throw new Error('path-mismatch');
  }
  if (config.enabled === true) throw new Error('stop-assistant-before-auth');
  if (config.userAuthSetupApproved !== true) throw new Error('auth-approval-required');
  if (config.identityVerificationMethod === 'oauth-union-id' && !UNION_ID_RE.test(config.expectedUserUnionId ?? '')) throw new Error('expected-identity-missing');

  const profileDirectory = join(config.bridgeHome, 'profiles', profile);
  return {
    key: safeKey, definition: { ...definition, identityVerificationMethod: verificationMethod, expectedUserUnionId: expectedUnionId }, config, configPath, directory: assistantDirectory,
    rootConfigPath: join(config.bridgeHome, 'config.json'),
    sourcePath: join(profileDirectory, 'lark-cli-source', 'config.json'),
    cliConfigDir: join(profileDirectory, 'lark-cli'),
    targetPath: join(profileDirectory, 'lark-cli', 'lark-channel', 'config.json'),
  };
}

function privateEnvironment(context) {
  const environment = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'PATHEXT', 'PATH', 'OS']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return {
    ...environment,
    CODEX_HOME: context.config.codexHome,
    LARK_CHANNEL: '1',
    LARK_CHANNEL_HOME: context.config.bridgeHome,
    LARK_CHANNEL_PROFILE: context.config.profile,
    LARK_CHANNEL_CONFIG: context.sourcePath,
    LARKSUITE_CLI_CONFIG_DIR: context.cliConfigDir,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  };
}

async function runCli(context, args) {
  const executable = toolPath('larkCli');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { env: privateEnvironment(context), cwd: context.config.workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const finish = (code, errorCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (errorCode) reject(new Error(errorCode));
      else resolvePromise({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill(); finish(null, 'cli-timeout'); }, 40_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 128 * 1024) { child.kill(); finish(null, 'cli-output-limit'); }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 64 * 1024) { child.kill(); finish(null, 'cli-output-limit'); }
    });
    child.once('error', () => finish(null, 'cli-unavailable'));
    child.once('close', (code) => finish(code));
  });
}

async function runCliInteractive(context, args) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(toolPath('larkCli'), args, {
        env: privateEnvironment(context),
        cwd: context.config.workspace,
        windowsHide: false,
        stdio: 'inherit',
      });
    } catch {
      reject(new Error('cli-unavailable'));
      return;
    }
    child.once('error', () => reject(new Error('cli-unavailable')));
    child.once('close', (code) => resolvePromise(Number.isInteger(code) ? code : 1));
  });
}

async function assertTarget(context, botOnly = false) {
  const target = JSON.parse((await readFile(context.targetPath, 'utf8')).replace(/^\uFEFF/, ''));
  const apps = Array.isArray(target.apps) ? target.apps : [];
  if (apps.length !== 1 || apps[0].appId !== context.config.appId || apps[0].brand !== 'feishu') throw new Error('private-app-mismatch');
  if (botOnly && (apps[0].defaultAs !== 'bot' || apps[0].strictMode !== 'bot')) throw new Error('bot-policy-not-restored');
  return apps[0];
}

async function prepare(context) {
  const root = JSON.parse((await readFile(context.rootConfigPath, 'utf8')).replace(/^\uFEFF/, ''));
  const profile = root.profiles?.[context.config.profile];
  if (!profile || Object.keys(root.profiles).length !== 1 || profile.accounts?.app?.id !== context.config.appId) throw new Error('profile-mismatch');
  const reference = profile.accounts.app.secret;
  if (reference?.source !== 'exec' || reference.provider !== 'bridge' || typeof reference.id !== 'string') throw new Error('encrypted-secret-reference-required');
  const getter = join(context.config.bridgeHome, 'secrets-getter.cmd');
  await realpath(getter);
  const getterScript = [
    '@echo off',
    'set "LARK_CHANNEL_HOME=%~dp0"',
    `set "LARK_CHANNEL_PROFILE=${context.config.profile}"`,
    '"%FEISHU_CODEX_NODE%" "%FEISHU_CODEX_BRIDGE_CLI%" secrets get %*',
  ].join('\r\n') + '\r\n';
  await writeFile(getter, getterScript, { encoding: 'ascii', mode: 0o600 });
  profile.permissions = { ...profile.permissions, defaultAccess: 'workspace', maxAccess: 'workspace' };
  profile.larkCli = { ...profile.larkCli, identityPreset: 'bot-only', localUserImport: { status: 'not-needed', reason: 'manual-bot-only' } };
  const providers = {
    ...(root.secrets?.providers ?? {}),
    bridge: {
      source: 'exec', command: getter, args: [],
      env: {
        LARK_CHANNEL_HOME: context.config.bridgeHome,
        LARK_CHANNEL_PROFILE: context.config.profile,
        FEISHU_CODEX_NODE: NODE_PATH,
        FEISHU_CODEX_BRIDGE_CLI: BRIDGE_CLI,
      },
    },
  };
  await atomicJson(context.rootConfigPath, root);
  await atomicJson(context.sourcePath, {
    accounts: { app: { id: context.config.appId, tenant: 'feishu', secret: reference } },
    secrets: { providers },
  });
  await mkdir(context.cliConfigDir, { recursive: true });
  const bound = await runCli(context, ['config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only']);
  if (bound.code !== 0) throw new Error('private-bind-failed');
  await assertTarget(context, true);
  return { status: 'private-auth-prepared', assistantKey: context.key, appId: context.config.appId, profile: context.config.profile, incomingEnabled: false, globalAuthImportRequested: false };
}

async function restoreBotOnly(context) {
  const restored = await runCli(context, ['config', 'strict-mode', 'bot']);
  if (restored.code !== 0) throw new Error('bot-policy-restore-failed');
  const defaultAs = await runCli(context, ['config', 'default-as', 'bot']);
  if (defaultAs.code !== 0) throw new Error('bot-policy-restore-failed');
  await assertTarget(context, true);
}

async function login(context) {
  await assertTarget(context, true);
  let completed = false;
  try {
    const relaxed = await runCli(context, ['config', 'strict-mode', 'off']);
    if (relaxed.code !== 0) throw new Error('private-bind-failed');
    const code = await runCliInteractive(context, ['auth', 'login', '--scope', 'contact:user.employee:readonly']);
    if (code !== 0) throw new Error('user-login-failed');
    completed = true;
  } finally {
    await restoreBotOnly(context);
  }
  return { status: 'user-login-complete', assistantKey: context.key, appId: context.config.appId, profile: context.config.profile, requestedScopes: ['contact:user.employee:readonly'], botOnlyRestored: true, incomingEnabled: false, verified: completed };
}

async function verify(context) {
  let verified;
  let identityMismatch = false;
  try {
    await assertTarget(context);
    const strictMode = await runCli(context, ['config', 'strict-mode', 'off']);
    const defaultAs = strictMode.code === 0 ? await runCli(context, ['config', 'default-as', 'auto']) : null;
    if (!defaultAs || defaultAs.code !== 0) throw new Error('private-bind-failed');
    const result = await runCli(context, ['api', 'GET', '/open-apis/authen/v1/user_info', '--as', 'user', '--json']);
    if (result.code !== 0) throw new Error('user-info-read-failed');
    const envelope = JSON.parse(result.stdout);
    const user = envelope?.data;
    const unionIdentity = context.config.identityVerificationMethod === 'oauth-union-id';
    const emailPresent = typeof user?.enterprise_email === 'string' && user.enterprise_email.trim().length > 0;
    const verification = {
      envelopeOk: envelope?.ok === true,
      identityIsUser: envelope?.identity === 'user',
      enterpriseEmailPresent: emailPresent,
      enterpriseEmailMatches: emailPresent && user.enterprise_email.trim().toLowerCase() === context.config.intendedUserEmail.trim().toLowerCase(),
      tenantMatches: user?.tenant_key === context.config.expectedTenantKey,
      appMatches: (await assertTarget(context)).appId === context.config.appId,
      openIdValid: OPEN_ID_RE.test(user?.open_id ?? ''),
      ...(unionIdentity ? {
        unionIdPresent: typeof user?.union_id === 'string' && UNION_ID_RE.test(user.union_id),
        unionIdMatches: user?.union_id === context.config.expectedUserUnionId,
      } : {}),
    };
    const personMatches = unionIdentity ? verification.unionIdMatches : verification.enterpriseEmailMatches;
    if (!verification.envelopeOk || !verification.identityIsUser || !personMatches || !verification.tenantMatches || !verification.appMatches || !verification.openIdValid) {
      identityMismatch = true;
      const missingEnterpriseEmail = !unionIdentity && verification.envelopeOk && verification.identityIsUser && verification.tenantMatches && verification.openIdValid && !verification.enterpriseEmailPresent;
      const error = new Error(missingEnterpriseEmail ? 'enterprise-email-missing' : 'authorized-user-mismatch');
      error.verification = verification;
      throw error;
    }
    await assertTarget(context);
    verified = {
      openId: user.open_id,
      enterpriseEmail: unionIdentity ? context.config.intendedUserEmail : user.enterprise_email.trim(),
      tenantKey: user.tenant_key,
      appId: context.config.appId,
      unionId: unionIdentity ? user.union_id : null,
      method: unionIdentity ? 'oauth-union-id' : 'oauth-enterprise-email',
    };
  } finally {
    if (identityMismatch) await runCli(context, ['auth', 'logout', '--json']).catch(() => {});
    await restoreBotOnly(context);
  }
  const latest = JSON.parse((await readFile(context.configPath, 'utf8')).replace(/^\uFEFF/, ''));
  const sameEmail = typeof latest.intendedUserEmail === 'string' && latest.intendedUserEmail.trim().toLowerCase() === verified.enterpriseEmail.trim().toLowerCase();
  if (latest.enabled === true || latest.appId !== verified.appId || latest.profile !== context.config.profile ||
      latest.expectedTenantKey !== verified.tenantKey || !sameEmail ||
      latest.identityVerificationMethod !== context.config.identityVerificationMethod || latest.expectedUserUnionId !== context.config.expectedUserUnionId) {
    throw new Error('configuration-changed-during-auth');
  }
  await atomicJson(context.configPath, {
    ...latest,
    allowedOpenId: verified.openId,
    identityVerified: true,
    verifiedAppId: verified.appId,
    verifiedTenantKey: verified.tenantKey,
    verifiedEnterpriseEmail: verified.enterpriseEmail,
    verifiedUserUnionId: verified.unionId,
    verifiedEnterpriseEmailSource: verified.unionId ? 'existing-owner-baseline-by-union-id' : 'new-profile-oauth-user-info',
    identityVerificationMethod: verified.method,
    identityVerifiedAt: new Date().toISOString(),
    enabled: false,
  });
  return { status: 'identity-verified', assistantKey: context.key, appId: verified.appId, profile: context.config.profile, tenantVerified: true, personVerified: true, botOnlyRestored: true, incomingEnabled: false };
}

const safeCodes = new Set([
  'unknown-assistant', 'config-mismatch', 'path-mismatch', 'stop-assistant-before-auth', 'auth-approval-required',
  'expected-identity-missing', 'cli-timeout', 'cli-output-limit', 'cli-unavailable', 'private-app-mismatch',
  'bot-policy-not-restored', 'profile-mismatch', 'encrypted-secret-reference-required', 'private-bind-failed',
  'bot-policy-restore-failed', 'user-info-read-failed', 'authorized-user-mismatch', 'enterprise-email-missing',
  'configuration-changed-during-auth', 'user-login-failed',
]);
try {
  const [mode, key] = process.argv.slice(2);
  if (!['prepare', 'login', 'verify'].includes(mode)) throw new Error('unknown-mode');
  const context = await loadAssistant(key);
  const result = mode === 'prepare' ? await prepare(context) : mode === 'login' ? await login(context) : await verify(context);
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({ status: 'not-completed', code: safeCodes.has(error?.message) ? error.message : 'configuration-or-runtime-unavailable', incomingEnabled: false, ...(error?.verification ? { verification: error.verification } : {}) }));
  process.exitCode = 1;
}
