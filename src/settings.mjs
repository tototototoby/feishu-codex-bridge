import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_ROOT = resolve(process.env.FEISHU_CODEX_HOME || join(homedir(), '.feishu-codex-bridge'));
export const CONFIG_PATH = resolve(process.env.FEISHU_CODEX_CONFIG || join(DATA_ROOT, 'config.json'));
function inside(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function physicalPath(path) {
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const next = dirname(ancestor);
    if (next === ancestor) throw new Error('Private storage ancestor is unavailable.');
    ancestor = next;
  }
  return resolve(realpathSync(ancestor), relative(ancestor, path));
}
export function assertPrivateStorage() {
  const actualProject = realpathSync(PROJECT_ROOT);
  for (const path of [DATA_ROOT, CONFIG_PATH]) {
    if (inside(PROJECT_ROOT, path) || inside(actualProject, physicalPath(path))) {
      throw new Error('Private data and configuration must stay outside the public source checkout, including junction targets.');
    }
  }
}
export function loadProjectConfig({ required = false } = {}) {
  assertPrivateStorage();
  if (!existsSync(CONFIG_PATH)) {
    if (required) throw new Error('Configuration missing. Run the init command and edit your local config.json.');
    return { schemaVersion: 1, assistants: {}, desktop: {}, group: {}, tools: {} };
  }
  let value;
  try { value = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Local configuration is not valid JSON.'); }
  if (value?.schemaVersion !== 1 || !value.assistants || typeof value.assistants !== 'object' || Array.isArray(value.assistants)) {
    throw new Error('Invalid project configuration. Expected schemaVersion 1 and an assistants object.');
  }
  for (const key of ['desktop', 'group', 'tools']) {
    if (value[key] != null && (typeof value[key] !== 'object' || Array.isArray(value[key]))) throw new Error(`Invalid ${key} configuration.`);
  }
  const directories = new Set();
  const profiles = new Set();
  for (const [key, entry] of Object.entries(value.assistants)) {
    safeAssistantSegment(key);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid assistant definition.');
    const directory = safeAssistantSegment(entry.directory || key).toLowerCase();
    const profile = safeAssistantSegment(entry.profile || key).toLowerCase();
    if (directories.has(directory) || profiles.has(profile)) throw new Error('Each assistant needs a distinct directory and profile.');
    directories.add(directory);
    profiles.add(profile);
  }
  return value;
}
export function toolPath(name) {
  const specified = loadProjectConfig().tools?.[name];
  if (specified != null && (typeof specified !== 'string' || !specified.trim())) throw new Error(`Invalid tool path: ${name}`);
  if (specified) return specified;
  if (name === 'node') return process.execPath;
  if (name === 'larkCli') return process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli';
  if (name === 'codex') return process.platform === 'win32' ? 'codex.cmd' : 'codex';
  throw new Error(`Tool path not configured: ${name}`);
}
export function upstreamRoot() {
  return resolve(dirname(fileURLToPath(import.meta.resolve('lark-channel-bridge'))), '..');
}
export function officeRoot() { return join(DATA_ROOT, 'assistants'); }
export function desktopRoot() { return join(DATA_ROOT, 'desktop'); }
export function safeAssistantSegment(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error('Assistant identifiers must use letters, numbers, hyphens or underscores.');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) throw new Error('Reserved assistant identifier.');
  if (['constructor', 'prototype', '__proto__'].includes(value)) throw new Error('Reserved assistant identifier.');
  return value;
}
export function absoluteConfiguredPath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute local path.`);
  return resolve(value);
}
