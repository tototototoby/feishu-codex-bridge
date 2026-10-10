import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { desktopRoot, loadProjectConfig, toolPath } from '../settings.mjs';

const APP_TOOLS_PLUGIN_PATH = ['plugins', 'cache', 'openai-bundled', 'codex-app-tools'];
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function projectConfig() {
  try { return loadProjectConfig(); } catch { return {}; }
}

export function desktopSettings() {
  const value = projectConfig().desktop;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function groupSettings() {
  const value = projectConfig().group;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function desktopEnabled() { return desktopSettings().enabled === true; }
export function groupEnabled() { return groupSettings().enabled === true; }
export function configuredDesktopChatId() {
  const value = desktopSettings().chatId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export function configuredDesktopThreadId() {
  const value = desktopSettings().threadId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export function configuredGroupChatId() {
  const value = groupSettings().chatId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export function configuredGroupOwnerId() {
  const value = groupSettings().ownerOpenId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export function configuredGroupName() {
  const value = groupSettings().name;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
export function configuredGroupOwnerName() {
  const value = groupSettings().ownerName;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
export function configuredGroupThreadId() {
  const value = groupSettings().threadId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function desktopControlPath(scope) {
  return join(desktopRoot(), scope && scope === configuredGroupChatId() ? 'group-desktop-control.json' : 'desktop-control.json');
}
export function desktopStatePath(scope) {
  return join(desktopRoot(), scope && scope === configuredGroupChatId() ? 'group-desktop-state.json' : 'desktop-dispatcher-state.json');
}
export function groupControlPath() { return join(desktopRoot(), 'group-control.json'); }
export function groupHistoryDirectory() { return join(desktopRoot(), 'group-history'); }
export function groupDatabasePath() { return join(groupHistoryDirectory(), 'messages.sqlite'); }
export function groupMediaStatePath() { return join(desktopRoot(), 'group-media-outbox.json'); }

export function isValidAppToolsPipePath(value) {
  if (typeof value !== 'string') return false;
  const match = value.trim().match(/^\\\\\.\\pipe\\([A-Za-z0-9._-]{8,140})$/i);
  if (!match || !/codex/i.test(match[1])) return false;
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(match[1]);
}

export function assertAppToolsPipePath(value) {
  if (!isValidAppToolsPipePath(value)) throw new Error('Invalid Codex App Tools pipe path.');
  return value.trim();
}

export function configuredNodePath() {
  try { return toolPath('node'); } catch { return process.execPath; }
}

export function configuredLarkCliPath() {
  try { return toolPath('larkCli'); } catch { return process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli'; }
}

/** Locate the installed Codex App Tools component without copying or vendoring it. */
export function resolveAppToolsServer() {
  const tools = projectConfig().tools;
  const explicit = tools && typeof tools === 'object' && typeof tools.appToolsServer === 'string'
    ? tools.appToolsServer.trim()
    : '';
  if (explicit) return resolveRequestedAppToolsServer(explicit);

  for (const installRoot of officialAppToolsRoots()) {
    const candidate = findHighestStableServer(installRoot);
    if (candidate) return candidate;
  }
  return null;
}

export function requireAppToolsServer(value) {
  const path = value ? resolveRequestedAppToolsServer(value) : resolveAppToolsServer();
  if (path && !isConfiguredOrInstalledServer(path)) throw new Error('Codex App Tools server must be the installed Codex App Tools component.');
  if (!path) throw new Error('Codex App Tools server is not installed or configured.');
  return path;
}

function isConfiguredOrInstalledServer(candidate) {
  const explicit = projectConfig().tools?.appToolsServer;
  if (typeof explicit === 'string' && explicit.trim()) {
    try { if (resolve(explicit) === candidate) return true; } catch { return false; }
  }
  return officialInstallRootForServer(candidate) !== null;
}

function existingAbsoluteFile(value) {
  if (!isAbsolute(value)) throw new Error('Codex App Tools server path must be absolute.');
  const path = resolve(value);
  if (!isRegularFile(path)) throw new Error('Codex App Tools server file is unavailable.');
  return path;
}

function isRegularFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function resolveRequestedAppToolsServer(value) {
  if (!isAbsolute(value)) throw new Error('Codex App Tools server path must be absolute.');
  const candidate = resolve(value);
  try {
    lstatSync(candidate);
    return existingAbsoluteFile(candidate);
  } catch (error) {
    if (error?.code !== 'ENOENT') return existingAbsoluteFile(candidate);
  }

  const installRoot = officialInstallRootForServer(candidate);
  const replacement = installRoot ? findHighestStableServer(installRoot) : null;
  return replacement ?? existingAbsoluteFile(candidate);
}

function officialAppToolsRoots() {
  const roots = [];
  const configuredHome = process.env.CODEX_HOME?.trim();
  if (configuredHome && isAbsolute(configuredHome)) {
    roots.push(resolve(join(configuredHome, ...APP_TOOLS_PLUGIN_PATH)));
  }
  roots.push(resolve(join(homedir(), '.codex', ...APP_TOOLS_PLUGIN_PATH)));

  const seen = new Set();
  return roots.filter((root) => {
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function officialInstallRootForServer(candidate) {
  if (!isAbsolute(candidate)) return null;
  const absoluteCandidate = resolve(candidate);
  for (const installRoot of officialAppToolsRoots()) {
    const parts = relative(installRoot, absoluteCandidate).replaceAll('\\', '/').split('/');
    if (parts.length === 2 && STABLE_SEMVER.test(parts[0]) && parts[1].toLowerCase() === 'server.mjs') {
      return installRoot;
    }
  }
  return null;
}

function findHighestStableServer(installRoot) {
  let canonicalRoot;
  let versions;
  try {
    if (!statSync(installRoot).isDirectory()) return null;
    canonicalRoot = realpathSync(installRoot);
    versions = readdirSync(installRoot).filter((entry) => STABLE_SEMVER.test(entry)).sort(compareStableVersionsDescending);
  } catch {
    return null;
  }

  for (const version of versions) {
    const versionPath = join(installRoot, version);
    const serverPath = join(versionPath, 'server.mjs');
    try {
      const versionStat = lstatSync(versionPath);
      if (!versionStat.isDirectory() || versionStat.isSymbolicLink()) continue;
      const canonicalVersion = realpathSync(versionPath);
      if (!isDirectChild(canonicalRoot, canonicalVersion)) continue;

      const serverStat = lstatSync(serverPath);
      if (!serverStat.isFile() || serverStat.isSymbolicLink()) continue;
      const canonicalServer = realpathSync(serverPath);
      if (!isWithin(canonicalRoot, canonicalServer) || !isWithin(canonicalVersion, canonicalServer)) continue;
      return serverPath;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      return null;
    }
  }
  return null;
}

function compareStableVersionsDescending(left, right) {
  const leftParts = left.match(STABLE_SEMVER).slice(1, 4).map(BigInt);
  const rightParts = right.match(STABLE_SEMVER).slice(1, 4).map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? -1 : 1;
  }
  return left < right ? 1 : left > right ? -1 : 0;
}

function isDirectChild(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent !== '' && !pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' &&
    !isAbsolute(pathFromParent) && !pathFromParent.includes(sep);
}

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' &&
    !isAbsolute(pathFromParent));
}
