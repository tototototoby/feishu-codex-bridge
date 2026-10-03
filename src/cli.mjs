#!/usr/bin/env node
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT, DATA_ROOT, CONFIG_PATH, loadProjectConfig, officeRoot, desktopRoot, safeAssistantSegment, toolPath, upstreamRoot, assertPrivateStorage } from './settings.mjs';

const help = `Feishu Codex Bridge v0.1.1 (Windows first)
  init                              Create private local configuration outside the checkout
  assistant init <key>               Create disabled isolated assistant folders from configuration
  doctor                            Inspect local prerequisites; does not send messages
  office <task-install|start|stop|status|check-ready> <key>
  office-auth <prepare|login|verify> <key>
  office setup <key>                 Open the local secure credential entry helper (Windows)
  office login-model <key>           Login to Codex in that assistant's private home
  desktop prepare                   Generate the pinned upstream Desktop adapter locally
  desktop profile <arguments>       Manage upstream profiles in dedicated private Desktop storage
  desktop start [run options]        Start the experimental adapter in the foreground

Set FEISHU_CODEX_HOME to choose your private data directory (e.g. D:\\FeishuCodexData).
The Desktop adapter requires the user's separately installed Codex Desktop/App Tools.
`;

function protectDataLocation() {
  assertPrivateStorage();
}
async function writeNewJson(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
async function init() {
  protectDataLocation();
  const example = JSON.parse(await readFile(join(PROJECT_ROOT, 'examples', 'config.example.json'), 'utf8'));
  await mkdir(DATA_ROOT, { recursive: true });
  await mkdir(desktopRoot(), { recursive: true });
  await mkdir(officeRoot(), { recursive: true });
  await writeNewJson(CONFIG_PATH, example);
  console.log(`Created ${CONFIG_PATH}. Edit your own application/person bindings locally, then run assistant init <key>.`);
}
async function initAssistant(key) {
  protectDataLocation();
  const cfg = loadProjectConfig({ required: true });
  const definition = cfg.assistants[key];
  if (!Object.hasOwn(cfg.assistants, key) || !definition) throw new Error('Assistant not configured. Add it to your private config.json first.');
  safeAssistantSegment(key);
  const directory = safeAssistantSegment(definition.directory || key);
  const profile = safeAssistantSegment(definition.profile || key);
  const method = definition.identityVerificationMethod || 'oauth-enterprise-email';
  if (!['oauth-enterprise-email', 'oauth-union-id'].includes(method)) throw new Error('Unsupported identity verification method.');
  if (method === 'oauth-union-id' && !/^on_[A-Za-z0-9_-]{8,128}$/.test(definition.expectedUserUnionId || '')) throw new Error('Union identity mode requires an independently established expectedUserUnionId.');
  const root = join(officeRoot(), directory);
  for (const sub of ['bridge', 'codex', 'workspace']) await mkdir(join(root, sub), { recursive: true });
  let template;
  try { template = JSON.parse((await readFile(join(PROJECT_ROOT, 'examples', 'assistant.example.json'), 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new Error('Assistant example template missing. Use a complete release checkout.'); }
  const value = {
    ...template, ...definition,
    schemaVersion: 1, profile, tenant: 'feishu', name: definition.displayName || key,
    enabled: false, identityVerified: false, allowedOpenId: null,
    allowGroupMessages: false, userAuthSetupApproved: false,
    workspace: join(root, 'workspace'), bridgeHome: join(root, 'bridge'), codexHome: join(root, 'codex'),
    identityVerificationMethod: method,
  };
  delete value.directory;
  for (const field of Object.keys(value)) {
    if (field.startsWith('verified') || field === 'identityVerifiedAt') delete value[field];
  }
  await writeNewJson(join(root, 'assistant.json'), value);
  console.log(`Created disabled assistant ${key}: ${root}. Follow docs/setup.md for credential and identity setup.`);
}
async function runNode(script, args, environment = process.env) {
  await access(script, constants.R_OK);
  const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit', windowsHide: true, env: environment });
  child.once('error', () => { console.error('Unable to start local module.'); process.exitCode = 1; });
  await new Promise(resolvePromise => child.once('close', code => { process.exitCode = code ?? 1; resolvePromise(); }));
}
async function runPs(script, args) {
  if (process.platform !== 'win32') throw new Error('This helper currently requires Windows.');
  await access(script, constants.R_OK);
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { stdio: 'inherit', windowsHide: true, env: process.env });
  child.once('error', () => { console.error('Unable to start Windows helper.'); process.exitCode = 1; });
  await new Promise(resolvePromise => child.once('close', code => { process.exitCode = code ?? 1; resolvePromise(); }));
}
async function doctor() {
  const require = createRequire(import.meta.url);
  const modules = {};
  for (const name of ['lark-channel-bridge', 'cross-spawn', 'proper-lockfile']) {
    try { modules[name] = name === 'lark-channel-bridge' ? !!upstreamRoot() : !!require.resolve(name); } catch { modules[name] = false; }
  }
  const cfg = loadProjectConfig();
  console.log(JSON.stringify({
    version: '0.1.1', platform: process.platform, node: process.versions.node,
    dataRoot: DATA_ROOT, configPath: CONFIG_PATH, dependencies: modules,
    assistants: Object.keys(cfg.assistants || {}),
    desktopEnabled: cfg.desktop?.enabled === true,
    larkCli: toolPath('larkCli'), codex: toolPath('codex'),
    limitation: 'Source/precondition inspection only; no model calls, chat sends or end-to-end validation.'
  }, null, 2));
  if (Object.values(modules).some(x => !x)) process.exitCode = 1;
}
async function main() {
  const [command, action, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') return console.log(help);
  protectDataLocation();
  if (command === 'init') return init();
  if (command === 'doctor') return doctor();
  if (command === 'assistant' && action === 'init' && rest.length === 1) return initAssistant(rest[0]);
  if (command === 'office' && ['task-install', 'start', 'stop', 'status', 'check-ready'].includes(action) && rest.length === 1) {
    return runNode(join(PROJECT_ROOT, 'src/office/office-entry.mjs'), [action, safeAssistantSegment(rest[0])]);
  }
  if (command === 'office-auth' && ['prepare', 'login', 'verify'].includes(action) && rest.length === 1) {
    return runNode(join(PROJECT_ROOT, 'src/office/office-auth.mjs'), [action, safeAssistantSegment(rest[0])]);
  }
  if (command === 'office' && ['setup', 'login-model'].includes(action) && rest.length === 1) {
    const script = action === 'setup' ? 'secure-profile-input.ps1' : 'login-model.ps1';
    return runPs(join(PROJECT_ROOT, 'src/office', script), ['-Assistant', safeAssistantSegment(rest[0])]);
  }
  if (command === 'desktop' && action === 'prepare') return runNode(join(PROJECT_ROOT, 'scripts/prepare-desktop.mjs'), []);
  if (command === 'desktop' && ['profile', 'start'].includes(action)) {
    const cfg = loadProjectConfig({ required: true });
    if (action === 'start' && cfg.desktop?.enabled !== true && cfg.group?.enabled !== true) throw new Error('Enable the experimental Desktop/group adapter explicitly in local configuration first.');
    protectDataLocation();
    const bridgeHome = join(desktopRoot(), 'bridge');
    const profile = safeAssistantSegment(cfg.desktop?.profile || 'desktop');
    if (rest.some(arg => arg === '--config' || arg === '-c' || arg.startsWith('--config=') || arg === '--app-secret' || arg.startsWith('--app-secret='))) {
      throw new Error('Use the dedicated private profile and interactive secret entry; config overrides and command-line secrets are not accepted.');
    }
    const environment = { ...process.env };
    for (const name of Object.keys(environment)) {
      if (/^(?:LARK|LARKSUITE|OPENCLAW|HERMES)/i.test(name)) delete environment[name];
    }
    Object.assign(environment, {
      FEISHU_CODEX_HOME: DATA_ROOT, FEISHU_CODEX_CONFIG: CONFIG_PATH,
      LARK_CHANNEL: '1', LARK_CHANNEL_HOME: bridgeHome, LARK_CHANNEL_PROFILE: profile,
      LARK_CHANNEL_CONFIG: join(bridgeHome, 'profiles', profile, 'lark-cli-source', 'config.json'),
      LARKSUITE_CLI_CONFIG_DIR: join(bridgeHome, 'profiles', profile, 'lark-cli'),
    });
    // The generated adapter path is fixed beneath private runtime storage.
    const args = action === 'profile' ? ['profile', ...rest] : ['run', '--config', join(bridgeHome, 'config.json'), '--profile', profile, ...rest];
    return runNode(join(desktopRoot(), 'cli-desktop.mjs'), args, environment);
  }
  throw new Error('Unknown command. Run --help.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
