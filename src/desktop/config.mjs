import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { desktopRoot, loadProjectConfig, toolPath } from '../settings.mjs';

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
  if (explicit) return existingAbsoluteFile(explicit);

  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const cacheRoot = join(codexHome, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  try {
    const versions = readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersions)
      .reverse();
    for (const version of versions) {
      const candidate = join(cacheRoot, version, 'server.mjs');
      if (isRegularFile(candidate)) return candidate;
    }
  } catch { /* App Tools is optional until desktop relay is enabled. */ }
  return null;
}

export function requireAppToolsServer(value) {
  const path = value ? existingAbsoluteFile(value) : resolveAppToolsServer();
  if (path && !isConfiguredOrInstalledServer(path)) throw new Error('Codex App Tools server must be the installed Codex App Tools component.');
  if (!path) throw new Error('Codex App Tools server is not installed or configured.');
  return path;
}

function isConfiguredOrInstalledServer(candidate) {
  const explicit = projectConfig().tools?.appToolsServer;
  if (typeof explicit === 'string' && explicit.trim()) {
    try { if (resolve(explicit) === candidate) return true; } catch { return false; }
  }
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const root = resolve(join(codexHome, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools'));
  const rootPrefix = `${root}${process.platform === 'win32' ? '\\' : '/'}`;
  const foldedCandidate = resolve(candidate).toLowerCase();
  const foldedRootPrefix = rootPrefix.toLowerCase();
  const relative = foldedCandidate.slice(foldedRootPrefix.length).replaceAll('\\', '/');
  return foldedCandidate.startsWith(foldedRootPrefix) && /^\/[^/]+\/server\.mjs$/i.test(relative);
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

function compareVersions(left, right) {
  const a = left.split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
  const b = right.split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y), undefined, { numeric: true });
  }
  return 0;
}
