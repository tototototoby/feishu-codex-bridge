import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig, officeRoot, safeAssistantSegment, toolPath } from '../settings.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const OFFICE_SOURCE_ROOT = MODULE_DIR;
const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{8,128}$/;
const APP_ID_RE = /^cli_[A-Za-z0-9_-]{8,128}$/;
const UNION_ID_RE = /^on_[A-Za-z0-9_-]{8,128}$/;

function definitionFor(key) {
  const safeKey = safeAssistantSegment(key);
  const config = loadProjectConfig({ required: true });
  const definition = config.assistants?.[safeKey];
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('unknown office assistant');
  const directory = safeAssistantSegment(definition.directory || safeKey);
  const profile = safeAssistantSegment(definition.profile || safeKey);
  if (typeof definition.displayName !== 'string' || !definition.displayName.trim()) throw new Error('assistant display name is missing');
  if (typeof definition.appId !== 'string' || !APP_ID_RE.test(definition.appId)) throw new Error('assistant app binding is invalid');
  if (typeof definition.intendedUserEmail !== 'string' || !definition.intendedUserEmail.trim()) throw new Error('assistant person binding is missing');
  if (typeof definition.expectedTenantKey !== 'string' || !definition.expectedTenantKey.trim()) throw new Error('assistant tenant binding is missing');
  if (definition.messageReply != null && !['card', 'markdown', 'text'].includes(definition.messageReply)) throw new Error('invalid assistant reply format');
  return { key: safeKey, definition, directory, profile };
}

export function listOfficeAssistants() {
  return Object.keys(loadProjectConfig().assistants ?? {}).filter((key) => {
    try { definitionFor(key); return true; } catch { return false; }
  });
}

export function expectedAssistantPaths(key) {
  const spec = definitionFor(key);
  const assistantDir = join(officeRoot(), spec.directory);
  const bridgeHome = join(assistantDir, 'bridge');
  return Object.freeze({
    name: spec.key,
    key: spec.key,
    displayName: spec.definition.displayName,
    profile: spec.profile,
    appId: spec.definition.appId,
    intendedUserEmail: spec.definition.intendedUserEmail,
    expectedTenantKey: spec.definition.expectedTenantKey,
    identityVerificationMethod: spec.definition.identityVerificationMethod || 'oauth-enterprise-email',
    expectedUserUnionId: spec.definition.expectedUserUnionId || null,
    visibility: spec.definition.visibility && typeof spec.definition.visibility === 'object' ? spec.definition.visibility : null,
    model: spec.definition.model || 'gpt-6.1-sol',
    reasoningEffort: spec.definition.reasoningEffort || 'high',
    messageReply: spec.definition.messageReply || null,
    assistantDir,
    assistantFile: join(assistantDir, 'assistant.json'),
    bridgeHome,
    codexHome: join(assistantDir, 'codex'),
    workspace: join(assistantDir, 'workspace'),
    profileConfigPath: join(bridgeHome, 'config.json'),
    profileCliConfigPath: join(bridgeHome, 'profiles', spec.profile, 'lark-cli', 'lark-channel', 'config.json'),
    cliPath: join(bridgeHome, 'cli-office.mjs'),
    pidFile: join(bridgeHome, '.office-runtime.pid.json'),
    lockFile: join(bridgeHome, '.office-runtime.lock'),
  });
}

function samePath(left, right) {
  return typeof left === 'string' && typeof right === 'string' &&
    resolve(left).replaceAll('/', '\\').toLowerCase() === resolve(right).replaceAll('/', '\\').toLowerCase();
}

function assertRealDirectory(expectedPath, label) {
  const stat = lstatSync(expectedPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} directory is not a real directory`);
  if (!samePath(realpathSync(expectedPath), expectedPath)) throw new Error(`${label} directory path mismatch`);
}

function emailMatches(actual, expected) {
  return typeof actual === 'string' && typeof expected === 'string' &&
    actual.trim().toLocaleLowerCase('en-US') === expected.trim().toLocaleLowerCase('en-US');
}

function identityIsReady(config, paths) {
  const unionIdentity = paths.identityVerificationMethod === 'oauth-union-id';
  const identityMethodValid = unionIdentity || paths.identityVerificationMethod === 'oauth-enterprise-email';
  const unionIdentityReady = !unionIdentity || (
    typeof paths.expectedUserUnionId === 'string' && UNION_ID_RE.test(paths.expectedUserUnionId) &&
    config.expectedUserUnionId === paths.expectedUserUnionId &&
    config.verifiedUserUnionId === paths.expectedUserUnionId
  );
  return config.enabled === true && config.identityVerified === true && identityMethodValid && unionIdentityReady &&
    config.appId === paths.appId && APP_ID_RE.test(config.appId) &&
    config.verifiedAppId === paths.appId &&
    config.expectedTenantKey === paths.expectedTenantKey &&
    config.verifiedTenantKey === paths.expectedTenantKey &&
    emailMatches(config.intendedUserEmail, paths.intendedUserEmail) &&
    emailMatches(config.verifiedEnterpriseEmail, paths.intendedUserEmail) &&
    typeof config.allowedOpenId === 'string' && OPEN_ID_RE.test(config.allowedOpenId) &&
    typeof config.codexBinaryPath === 'string' && isAbsolute(config.codexBinaryPath) && /^codex(?:\.exe|\.cmd)?$/i.test(basename(config.codexBinaryPath)) &&
    config.tenant === 'feishu' && config.allowGroupMessages === false &&
    config.model === paths.model && config.reasoningEffort === paths.reasoningEffort;
}

export function loadOfficeAssistant(key, { requireReady = false } = {}) {
  const paths = expectedAssistantPaths(key);
  assertRealDirectory(officeRoot(), 'office root');
  assertRealDirectory(paths.assistantDir, 'assistant');
  assertRealDirectory(paths.bridgeHome, 'bridge home');
  assertRealDirectory(paths.codexHome, 'Codex home');
  assertRealDirectory(paths.workspace, 'workspace');

  const assistantStat = lstatSync(paths.assistantFile);
  if (!assistantStat.isFile() || assistantStat.isSymbolicLink()) throw new Error('assistant config is not a regular file');
  const config = JSON.parse(readFileSync(paths.assistantFile, 'utf8').replace(/^\uFEFF/, ''));
  const mappingValid = config?.schemaVersion === 1 &&
    config?.profile === paths.profile && config?.tenant === 'feishu' &&
    config?.appId === paths.appId && emailMatches(config?.intendedUserEmail, paths.intendedUserEmail) &&
    config?.expectedTenantKey === paths.expectedTenantKey &&
    config?.identityVerificationMethod === paths.identityVerificationMethod &&
    (paths.expectedUserUnionId == null || config?.expectedUserUnionId === paths.expectedUserUnionId) &&
    samePath(config?.workspace, paths.workspace) && samePath(config?.bridgeHome, paths.bridgeHome) &&
    samePath(config?.codexHome, paths.codexHome) && config?.allowGroupMessages === false &&
    config?.model === paths.model && config?.reasoningEffort === paths.reasoningEffort;
  if (!mappingValid) throw new Error('assistant config does not match its configured office mapping');

  const identityReady = identityIsReady(config, paths);
  if (requireReady && !identityReady) throw new Error('assistant identity is not verified and enabled');

  return Object.freeze({
    ...paths,
    codexBinaryPath: typeof config.codexBinaryPath === 'string' ? config.codexBinaryPath : null,
    allowedOpenId: typeof config.allowedOpenId === 'string' ? config.allowedOpenId : null,
    enabled: config.enabled === true,
    identityVerified: config.identityVerified === true,
    ready: identityReady,
    profileCliConfigPath: paths.profileCliConfigPath,
  });
}

export function loadOfficeAssistantFromProcess({ requireReady = false } = {}) {
  if (process.env.LARK_OFFICE_RUNTIME !== '1') throw new Error('managed office runtime marker is missing');
  const key = process.env.LARK_OFFICE_ASSISTANT;
  const assistant = loadOfficeAssistant(key, { requireReady });
  if (!samePath(process.env.LARK_OFFICE_ASSISTANT_FILE, assistant.assistantFile) ||
      !samePath(process.env.LARK_CHANNEL_HOME, assistant.bridgeHome) ||
      !samePath(process.env.CODEX_HOME, assistant.codexHome) ||
      process.env.LARK_CHANNEL_PROFILE !== assistant.profile) {
    throw new Error('process-local office paths do not match the assistant mapping');
  }
  return assistant;
}

export function isOfficeRuntime() {
  return process.env.LARK_OFFICE_RUNTIME === '1';
}

export function assertOfficeRunOptions(options) {
  const assistant = loadOfficeAssistantFromProcess({ requireReady: true });
  if (options?.webUi === true || options?.profile !== assistant.profile || !samePath(options?.config, assistant.profileConfigPath)) {
    throw new Error('office CLI must run only its mapped profile and config');
  }
}

export function isOfficeAllowedOpenId(senderId) {
  if (!isOfficeRuntime()) return false;
  try {
    const assistant = loadOfficeAssistantFromProcess({ requireReady: true });
    return typeof senderId === 'string' && senderId === assistant.allowedOpenId;
  } catch {
    return false;
  }
}

export function enforceOfficeProfilePolicy(profileConfig, { profile, rootDir, configPath, appId }) {
  const assistant = loadOfficeAssistantFromProcess({ requireReady: true });
  if (profile !== assistant.profile || !samePath(rootDir, assistant.bridgeHome) ||
      !samePath(configPath, assistant.profileConfigPath) || appId !== assistant.appId ||
      profileConfig?.accounts?.app?.id !== assistant.appId || profileConfig?.agentKind !== 'codex' ||
      !assistant.codexBinaryPath || !samePath(profileConfig.codex?.binaryPath, assistant.codexBinaryPath)) {
    throw new Error('loaded bridge profile does not match the verified assistant mapping');
  }

  const codexBinary = profileConfig.codex?.binaryPath;
  const configuredCodex = toolPath('codex');
  if (!codexBinary || !isAbsolute(codexBinary) || !/^codex(?:\.exe|\.cmd)?$/i.test(basename(codexBinary))) {
    throw new Error('Codex binary is not configured as an absolute executable path');
  }
  if (isAbsolute(configuredCodex) && !samePath(codexBinary, configuredCodex)) {
    throw new Error('profile Codex binary does not match the configured executable');
  }
  const rel = relative(assistant.assistantDir, resolve(codexBinary));
  if (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) throw new Error('Codex binary cannot be inside an assistant data directory');

  profileConfig.mode = 'personal';
  const existingReply = profileConfig.preferences?.messageReply;
  const keepsExistingReply = !assistant.messageReply && ['card', 'markdown', 'text'].includes(existingReply);
  const messageReply = assistant.messageReply || (keepsExistingReply ? existingReply : 'card');
  profileConfig.preferences ??= {};
  profileConfig.preferences.messageReply = messageReply;
  if (!keepsExistingReply) profileConfig.preferences.messageReplyMigrated = true;
  profileConfig.access = {
    ...profileConfig.access,
    allowedUsers: [assistant.allowedOpenId],
    allowedChats: [],
    admins: [assistant.allowedOpenId],
    requireMentionInGroup: true,
    chatRequireMention: {},
  };
  profileConfig.workspaces = { ...profileConfig.workspaces, default: assistant.workspace };

  const defaultAccess = profileConfig.permissions?.defaultAccess === 'read-only' ? 'read-only' : 'workspace';
  profileConfig.permissions = { ...profileConfig.permissions, defaultAccess, maxAccess: 'workspace' };
  const defaultSandbox = defaultAccess === 'read-only' ? 'read-only' : 'workspace-write';
  profileConfig.sandbox = { default: defaultSandbox, max: 'workspace-write', defaultMode: defaultSandbox, maxMode: 'workspace-write' };
  profileConfig.codex = { ...profileConfig.codex, codexHome: void 0, inheritCodexHome: true, ignoreUserConfig: false, ignoreRules: false };
  profileConfig.larkCli = { identityPreset: 'bot-only', localUserImport: { status: 'not-needed', reason: 'manual-bot-only' } };
  return profileConfig;
}
