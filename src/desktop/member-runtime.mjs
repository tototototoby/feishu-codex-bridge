import { readFileSync } from 'node:fs';

export function configuredMcpServerNames(configPath) {
  let config = '';
  try { config = readFileSync(configPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (/^\s*mcp_servers(?:\.[^=]+)?\s*=/m.test(config) || /^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$/m.test(config)) throw new Error('unsupported-inline-mcp-config');
  const names = [...config.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/gm)]
    .map((match) => match[1] || match[2] || match[3]);
  for (const name of names) if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('unsupported-member-mcp-name');
  return [...new Set(names)];
}

export function buildMemberCommandArgs(input) {
  if (typeof input.cwd !== 'string' || !input.cwd) throw new Error('member-workspace-required');
  return ['exec', '--json', '--sandbox', 'read-only',
    ...(input.model ? ['--model', input.model] : []),
    ...(input.reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`] : []),
    ...memberRuntimeFlags(input.disabledMcpServers, { memberImagesEnabled: input.memberImagesEnabled === true }),
    '-c', 'approval_policy="never"', '-c', 'shell_environment_policy.inherit="all"',
    ...(input.ignoreUserConfig ? ['--ignore-user-config'] : []), '--ignore-rules', '--skip-git-repo-check', '-C', input.cwd,
    ...(input.images ?? []).flatMap((image) => ['--image', image]),
    ...((input.images ?? []).length ? ['--'] : []), '-'];
}

export function memberRuntimeFlags(disabledMcpServers = [], { memberImagesEnabled = false } = {}) {
  for (const name of disabledMcpServers) if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('unsupported-member-mcp-name');
  return [
    '--ephemeral',
    '-c', 'web_search="disabled"',
    // Preserve transport/provider configuration; only disable each named server.
    ...disabledMcpServers.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
    ...[
      'shell_tool', 'unified_exec', 'code_mode', 'code_mode_host', 'apps', 'plugins',
      'remote_plugin', 'skill_search', 'skill_mcp_dependency_install', 'multi_agent', 'multi_agent_v2',
      'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'artifact',
      'goals', 'hooks', 'workspace_dependencies', 'in_app_local_automation', 'tool_suggest', 'memories',
      'view_image', 'sleep_tool', 'request_permissions_tool'
    ].flatMap((feature) => ['-c', `features.${feature}=false`]),
    // Native imagegen needs the registered-tool host. Keep general code mode,
    // shell execution, apps, plugins and MCP disabled above.
    ...(memberImagesEnabled ? ['-c', 'features.code_mode_host=true', '-c', 'features.image_generation=true'] : []),
    '-c', 'features.skip_host_skill_discovery=true'
  ];
}

// Keep only OS/runtime, transport and model-provider credentials. In particular,
// never inherit Feishu credentials, desktop app tools, or unrelated service keys.
export function buildMemberProcessEnv(environment = process.env, overrides = {}) {
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|USERNAME|USERDOMAIN|LANG|LC_ALL|LC_CTYPE|TZ|TERM|NO_COLOR|FORCE_COLOR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CODEX_HOME|OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT_ID|AZURE_OPENAI_API_KEY|AZURE_OPENAI_ENDPOINT|CODEX_API_KEY)$/i;
  return Object.fromEntries(Object.entries({ ...environment, ...overrides })
    .filter(([key, value]) => allowed.test(key) && typeof value === 'string'));
}
