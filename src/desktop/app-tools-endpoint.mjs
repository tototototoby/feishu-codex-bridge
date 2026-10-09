import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { AppToolsMcpClient } from "./app-tools-client.mjs";
import { assertAppToolsPipePath, configuredNodePath, requireAppToolsServer } from "./config.mjs";

const PIPE_ROOT = "\\\\.\\pipe\\";
const PIPE_PATH_ENV = "CODEX_APP_TOOLS_PIPE_PATH";
const UUID_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METADATA_TIMEOUT_MS = 10_000;
const METADATA_MAX_OUTPUT_BYTES = 8 * 1024;
const LIST_CALL_TIMEOUT_MS = 3_000;
const THREADS_CALL_TIMEOUT_MS = 5_000;
const DISCOVERY_TOTAL_TIMEOUT_MS = 20_000;
const MCP_CLOSE_RESERVE_MS = 1_700;
const SUCCESS_TTL_MS = 10_000;
const NEGATIVE_TTL_MS = 5_000;
const MAX_CANDIDATES = 6;
const MAX_FALLBACK_CANDIDATES = 32;
const ANCHOR_PROBE_CONCURRENCY = 8;
const MAX_AUTO_NAMESPACES = 4;
const MAX_CACHE_ENTRIES = 128;
const discoveries = new Map();

const POWERSHELL_PIPE_OWNER_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$nativeSource = @'
using System;
using System.Runtime.InteropServices;
public static class PipeOwnerProbeNative {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFile(string name, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flags, IntPtr templateFile);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetNamedPipeServerProcessId(IntPtr pipeHandle, out uint serverProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@
$results = New-Object 'System.Collections.Generic.List[object]'
try {
    Add-Type -TypeDefinition $nativeSource -ErrorAction Stop | Out-Null
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $inputText = [Console]::In.ReadToEnd()
    $inputDocument = ConvertFrom-Json -InputObject $inputText -ErrorAction Stop
    $candidates = @($inputDocument.candidates)
    foreach ($candidate in $candidates) {
        $index = 0
        $serverProcessId = [long]0
        $verified = $false
        $pipeHandle = [IntPtr]::Zero
        try {
            $index = [int]$candidate.index
            $pipeHandle = [PipeOwnerProbeNative]::CreateFile([string]$candidate.pipePath, 0, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
            if ($pipeHandle -ne [IntPtr]::Zero -and $pipeHandle -ne [IntPtr](-1)) {
                [uint32]$ownerProcessId = 0
                if ([PipeOwnerProbeNative]::GetNamedPipeServerProcessId($pipeHandle, [ref]$ownerProcessId)) {
                    $serverProcessId = [long]$ownerProcessId
                    try {
                        $process = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + $serverProcessId) -ErrorAction Stop
                        $processPath = [string]$process.ExecutablePath
                        $exeName = [System.IO.Path]::GetFileName($processPath)
                        $expectedExe = ($exeName -ieq 'ChatGPT.exe' -or $exeName -ieq 'Codex.exe')
                        $localCodexRoot = ''
                        if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
                            $localCodexRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'OpenAI\Codex')).TrimEnd('\') + '\'
                        }
                        $underLocalCodex = $localCodexRoot -and $processPath.StartsWith($localCodexRoot, [System.StringComparison]::OrdinalIgnoreCase)
                        $underWindowsApps = $false
                        if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
                            $windowsAppsRoot = [System.IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'WindowsApps')).TrimEnd('\') + '\'
                            if ($processPath.StartsWith($windowsAppsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                                $relativePath = $processPath.Substring($windowsAppsRoot.Length)
                                $packageDirectory = $relativePath.Split('\')[0]
                                $underWindowsApps = ($packageDirectory -match '^OpenAI\.Codex_.+' -and $relativePath.Contains('\'))
                            }
                        }
                        if ($expectedExe -and ($underLocalCodex -or $underWindowsApps)) {
                            $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
                            $verified = ($owner.ReturnValue -eq 0 -and [string]$owner.Sid -eq $currentSid)
                        }
                    } catch {
                        $verified = $false
                    }
                }
            }
        } catch {
            $verified = $false
        } finally {
            if ($pipeHandle -ne [IntPtr]::Zero -and $pipeHandle -ne [IntPtr](-1)) {
                [PipeOwnerProbeNative]::CloseHandle($pipeHandle) | Out-Null
            }
        }
        $results.Add([pscustomobject]@{ index = [int]$index; pid = [long]$serverProcessId; verified = [bool]$verified })
    }
} catch {
    $results.Clear()
}
$output = $results.ToArray()
ConvertTo-Json -InputObject $output -Compress -Depth 3
`;

/** Find the current app-tools pipe by verifying that it can see the anchor thread. */
export async function discoverAppToolsEndpoint({ control, anchorThreadId } = {}) {
  let suppliedPipePath = "";
  let serverPath;
  try {
    const configuredPipe = typeof control?.pipePath === "string" ? control.pipePath.trim() : "";
    suppliedPipePath = configuredPipe ? assertAppToolsPipePath(configuredPipe) : "";
    serverPath = control?.serverPath ? requireAppToolsServer(control.serverPath) : requireAppToolsServer();
  } catch { return null; }
  if (typeof anchorThreadId !== "string" || !anchorThreadId.trim()) return null;

  const suppliedName = suppliedPipePath ? suppliedPipePath.split(/[\\/]/).at(-1) : "";
  const suppliedNamespace = suppliedName ? getNamespace(suppliedName) : null;
  if (suppliedName && !suppliedNamespace) return null;

  let environmentPipePath = "";
  const rawEnvironmentPipePath = typeof process.env[PIPE_PATH_ENV] === "string"
    ? process.env[PIPE_PATH_ENV].trim()
    : "";
  if (rawEnvironmentPipePath) {
    try { environmentPipePath = assertAppToolsPipePath(rawEnvironmentPipePath); } catch {}
  }
  const environmentName = environmentPipePath ? environmentPipePath.split(/[\\/]/).at(-1) : "";
  const environmentNamespace = environmentName ? getNamespace(environmentName) : null;
  const namespace = suppliedNamespace;
  let fallbackPreferredName = "";
  if (
    environmentNamespace && namespace &&
    environmentNamespace.prefix.toLowerCase() === namespace.prefix.toLowerCase()
  ) {
    fallbackPreferredName = environmentName;
  }

  const key = `${namespace?.prefix ?? "*"}\0${anchorThreadId}`;
  const now = Date.now();
  pruneCache(now);
  const cached = discoveries.get(key);
  if (cached?.promise) return cached.promise;
  if (cached?.endpoint && cached.expiresAt > now) return cached.endpoint;
  if (cached?.negativeUntil > now) return null;

  const state = { promise: null };
  const discover = namespace
    ? findEndpoint({
      namespace,
      preferredName: suppliedName,
      fallbackPreferredName,
      anchorThreadId,
      serverPath,
      nodePath: control?.nodePath || configuredNodePath(),
    })
    : discoverAcrossNamespaces({
      anchorThreadId,
      serverPath,
      nodePath: control?.nodePath || configuredNodePath(),
    });
  state.promise = discover.then((endpoint) => {
    if (endpoint) discoveries.set(key, { endpoint, expiresAt: Date.now() + SUCCESS_TTL_MS });
    else discoveries.set(key, { negativeUntil: Date.now() + NEGATIVE_TTL_MS });
    return endpoint;
  }).catch(() => {
    discoveries.set(key, { negativeUntil: Date.now() + NEGATIVE_TTL_MS });
    return null;
  });
  discoveries.set(key, state);
  return state.promise;
}

async function discoverAcrossNamespaces({ anchorThreadId, serverPath, nodePath }) {
  let names;
  try { names = await readdir(PIPE_ROOT); } catch { return null; }
  const namespaces = new Map();
  for (const name of names) {
    const namespace = getNamespace(name);
    if (namespace) namespaces.set(namespace.prefix.toLowerCase(), namespace);
  }
  if (namespaces.size < 1 || namespaces.size > MAX_AUTO_NAMESPACES) return null;
  const deadline = Date.now() + DISCOVERY_TOTAL_TIMEOUT_MS;
  const endpoints = (await Promise.all([...namespaces.values()].map((namespace) =>
    findEndpoint({ namespace, anchorThreadId, serverPath, nodePath, deadline }),
  ))).filter(Boolean);
  const unique = new Map(endpoints.map((endpoint) => [endpoint.pipePath.toLowerCase(), endpoint]));
  return unique.size === 1 ? unique.values().next().value : null;
}

function getNamespace(name) {
  if (typeof name !== "string") return null;
  if (!/^[A-Za-z0-9._-]{8,140}$/.test(name) || !/codex/i.test(name)) return null;
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!match) return null;
  const prefix = name.slice(0, -match[1].length);
  if (prefix.length < 8 || prefix.length > 80 || !/codex/i.test(prefix)) return null;
  return { prefix };
}

async function findEndpoint({ namespace, preferredName, fallbackPreferredName, anchorThreadId, serverPath, nodePath, deadline }) {
  const discoveryDeadline = deadline ?? (Date.now() + DISCOVERY_TOTAL_TIMEOUT_MS);
  let names;
  try {
    names = await readdir(PIPE_ROOT);
  } catch {
    return null;
  }
  if (Date.now() >= discoveryDeadline) return null;

  const matchingNames = [];
  const seen = new Set();
  for (const name of names) {
    if (typeof name !== "string" || !name.startsWith(namespace.prefix)) continue;
    if (!UUID_SUFFIX.test(name.slice(namespace.prefix.length))) continue;
    const folded = name.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    matchingNames.push(name);
  }

  const preferred = preferredName
    ? matchingNames.find((name) => name.toLowerCase() === preferredName.toLowerCase())
    : null;
  if (!preferred && preferredName) {
    return findFallbackEndpoint({
      names: matchingNames,
      fallbackPreferredName,
      anchorThreadId,
      serverPath,
      nodePath,
      discoveryDeadline,
    });
  }

  const orderedNames = preferred
    ? [preferred, ...matchingNames.filter((name) => name !== preferred)]
    : matchingNames;
  const candidateSetTruncated = orderedNames.length > MAX_CANDIDATES;
  const candidates = orderedNames.slice(0, MAX_CANDIDATES).map((name, index) => ({
    index,
    name,
    pipePath: `${PIPE_ROOT}${name}`,
  }));
  if (candidates.length === 0) return null;

  const remainingBeforeMetadata = discoveryDeadline - Date.now();
  const metadataTimeoutMs = Math.min(
    METADATA_TIMEOUT_MS,
    remainingBeforeMetadata - THREADS_CALL_TIMEOUT_MS - MCP_CLOSE_RESERVE_MS,
  );
  if (metadataTimeoutMs <= 0) return null;
  const ownership = await getVerifiedDesktopPipeOwners(candidates, metadataTimeoutMs);
  const ownerByIndex = new Map(ownership.map((entry) => [entry.index, entry]));
  const preferredCandidate = preferred
    ? candidates.find((candidate) => candidate.name.toLowerCase() === preferred.toLowerCase())
    : null;
  const preferredOwner = preferredCandidate ? ownerByIndex.get(preferredCandidate.index) : null;

  const preferredVerified = preferredOwner?.verified && preferredOwner.pid > 0;
  if (Date.now() >= discoveryDeadline) return null;
  if (preferredVerified) {
    const timeoutMs = nextProbeBudget(discoveryDeadline);
    if (timeoutMs > 0) {
      const found = await pipeHasAnchorThread({
        pipePath: preferredCandidate.pipePath,
        anchorThreadId,
        serverPath,
        nodePath,
        timeoutMs,
      });
      if (found) return { pipePath: preferredCandidate.pipePath };
    }
  }

  if (preferred) {
    return findFallbackEndpoint({
      names: matchingNames,
      fallbackPreferredName,
      anchorThreadId,
      serverPath,
      nodePath,
      discoveryDeadline,
    });
  }

  if (candidateSetTruncated) return null;

  const verifiedCandidates = candidates.filter((candidate) => {
    const owner = ownerByIndex.get(candidate.index);
    return owner?.verified && owner.pid > 0;
  });
  const desktopPids = new Set(verifiedCandidates.map((candidate) => ownerByIndex.get(candidate.index).pid));
  if (desktopPids.size !== 1) return null;
  const onlyDesktopPid = desktopPids.values().next().value;

  for (const candidate of verifiedCandidates) {
    if (ownerByIndex.get(candidate.index).pid !== onlyDesktopPid) continue;
    if (preferredVerified && candidate.index === preferredCandidate.index) continue;
    const timeoutMs = nextProbeBudget(discoveryDeadline);
    if (timeoutMs <= 0) break;
    const found = await pipeHasAnchorThread({
      pipePath: candidate.pipePath,
      anchorThreadId,
      serverPath,
      nodePath,
      timeoutMs,
    });
    if (found) {
      return { pipePath: candidate.pipePath };
    }
  }
  return null;
}

async function findFallbackEndpoint({
  names,
  fallbackPreferredName,
  anchorThreadId,
  serverPath,
  nodePath,
  discoveryDeadline,
}) {
  if (names.length === 0 || names.length > MAX_FALLBACK_CANDIDATES) return null;

  const fallbackPreferred = fallbackPreferredName
    ? names.find((name) => name.toLowerCase() === fallbackPreferredName.toLowerCase())
    : null;
  const orderedNames = fallbackPreferred
    ? [fallbackPreferred, ...names.filter((name) => name !== fallbackPreferred)]
    : names;
  const candidates = orderedNames.map((name, index) => ({
    index,
    name,
    pipePath: `${PIPE_ROOT}${name}`,
  }));

  const remainingBeforeMetadata = discoveryDeadline - Date.now();
  const metadataTimeoutMs = Math.min(
    METADATA_TIMEOUT_MS,
    remainingBeforeMetadata - THREADS_CALL_TIMEOUT_MS - MCP_CLOSE_RESERVE_MS,
  );
  if (metadataTimeoutMs <= 0) return null;

  const ownership = await getVerifiedDesktopPipeOwners(candidates, metadataTimeoutMs);
  if (
    Date.now() >= discoveryDeadline ||
    ownership.length !== candidates.length ||
    ownership.some((entry) => !entry.verified || entry.pid <= 0)
  ) {
    return null;
  }

  const desktopPids = new Set(ownership.map((entry) => entry.pid));
  if (desktopPids.size !== 1) return null;

  const found = await findAnchorAmongCandidates({
    candidates,
    anchorThreadId,
    serverPath,
    nodePath,
    discoveryDeadline,
  });
  return found ? { pipePath: found.pipePath } : null;
}

async function findAnchorAmongCandidates({ candidates, anchorThreadId, serverPath, nodePath, discoveryDeadline }) {
  let nextIndex = 0;
  let found = null;
  const workerCount = Math.min(ANCHOR_PROBE_CONCURRENCY, candidates.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!found) {
      if (Date.now() >= discoveryDeadline - MCP_CLOSE_RESERVE_MS) return;
      const index = nextIndex;
      nextIndex += 1;
      const candidate = candidates[index];
      if (!candidate) return;

      const remainingCandidates = candidates.length - index;
      const remainingBatches = Math.max(1, Math.ceil(remainingCandidates / ANCHOR_PROBE_CONCURRENCY));
      const availableMs = discoveryDeadline - Date.now() - MCP_CLOSE_RESERVE_MS;
      const timeoutMs = Math.min(THREADS_CALL_TIMEOUT_MS, Math.floor(availableMs / remainingBatches));
      if (timeoutMs <= 0) return;

      const matches = await pipeHasAnchorThread({
        pipePath: candidate.pipePath,
        anchorThreadId,
        serverPath,
        nodePath,
        timeoutMs,
      });
      if (matches && !found) found = candidate;
    }
  });
  await Promise.all(workers);
  return found;
}

function nextProbeBudget(deadline) {
  const remaining = deadline - Date.now() - MCP_CLOSE_RESERVE_MS;
  return Math.min(THREADS_CALL_TIMEOUT_MS, remaining);
}

function getVerifiedDesktopPipeOwners(candidates, timeoutMs) {
  if (!Array.isArray(candidates) || candidates.length === 0 || timeoutMs <= 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timer;
    let child;

    const finish = (rows) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(rows);
    };

    try {
      child = spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_PIPE_OWNER_PROBE],
        { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
      );
    } catch {
      finish([]);
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The metadata probe fails closed if its process cannot be stopped.
      }
      finish([]);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(output, "utf8") + Buffer.byteLength(chunk, "utf8") > METADATA_MAX_OUTPUT_BYTES) {
        try {
          child.kill();
        } catch {
          // The bounded output check is a fail-closed guard.
        }
        finish([]);
        return;
      }
      output += chunk;
    });
    child.once("error", () => finish([]));
    child.once("close", (code) => {
      if (code !== 0) {
        finish([]);
        return;
      }
      finish(parseOwnerRows(output, candidates.length));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ candidates: candidates.map(({ index, pipePath }) => ({ index, pipePath })) }));
  });
}

function parseOwnerRows(output, candidateCount) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length !== candidateCount) return [];
  const sanitized = [];
  const seen = new Set();
  for (const row of rows) {
    if (
      Number.isInteger(row?.index) && row.index >= 0 && row.index < candidateCount &&
      Number.isInteger(row?.pid) && row.pid >= 0 && typeof row?.verified === "boolean"
    ) {
      if (seen.has(row.index)) return [];
      seen.add(row.index);
      sanitized.push({ index: row.index, pid: row.pid, verified: row.verified });
    } else {
      return [];
    }
  }
  return seen.size === candidateCount ? sanitized : [];
}

async function pipeHasAnchorThread({ pipePath, anchorThreadId, serverPath, nodePath, timeoutMs }) {
  let client;
  let timeout;
  try {
    client = new AppToolsMcpClient({
      pipePath,
      serverPath,
      nodePath,
      threadId: anchorThreadId,
      timeoutMs: LIST_CALL_TIMEOUT_MS,
    });
    const probe = async () => {
      const tools = await client.listTools({ timeoutMs: LIST_CALL_TIMEOUT_MS });
      const readThreadTool = tools.find((tool) =>
        typeof tool?.name === "string" && tool.name.toLowerCase().endsWith("read_thread"),
      );
      if (!readThreadTool) return false;

      const properties = readThreadTool.inputSchema?.properties ?? {};
      if (!Object.hasOwn(properties, "threadId") || !Object.hasOwn(properties, "hostId")) return false;
      const args = { threadId: anchorThreadId, hostId: "local" };
      if (Object.hasOwn(properties, "turnLimit")) args.turnLimit = 1;
      if (Object.hasOwn(properties, "includeOutputs")) args.includeOutputs = false;
      if (Object.hasOwn(properties, "maxOutputCharsPerItem")) args.maxOutputCharsPerItem = 0;
      if ((readThreadTool.inputSchema?.required ?? []).some((key) => args[key] === undefined)) return false;
      const result = await client.callTool(readThreadTool.name, args, { timeoutMs: THREADS_CALL_TIMEOUT_MS });
      return !result?.isError && containsAnchorThread(result, anchorThreadId);
    };
    const timeLimit = new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), Math.max(timeoutMs, 1));
    });
    return await Promise.race([probe().catch(() => false), timeLimit]);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    if (client) {
      try {
        await client.close({ graceMs: 50 });
      } catch {
        // Probe failures are intentionally silent; pipe names must not escape.
      }
    }
  }
}

function containsAnchorThread(result, anchorThreadId) {
  const sources = [];
  if (isObject(result?.structuredContent)) sources.push(result.structuredContent);
  if (Array.isArray(result?.parsedContent)) {
    for (const item of result.parsedContent) {
      if (isObject(item?.parsed)) sources.push(item.parsed);
    }
  }

  for (const source of sources) {
    if (isAnchorThread(source.thread, anchorThreadId)) return true;
  }
  return false;
}

function isAnchorThread(entry, anchorThreadId) {
  if (!isObject(entry) || entry.id !== anchorThreadId) return false;
  return entry.hostId === "local" && entry.kind === "codex";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pruneCache(now) {
  for (const [key, entry] of discoveries) {
    if (!entry.promise && (entry.expiresAt ?? entry.negativeUntil ?? 0) <= now) discoveries.delete(key);
  }
  if (discoveries.size <= MAX_CACHE_ENTRIES) return;
  for (const [key, entry] of discoveries) {
    if (entry.promise) continue;
    discoveries.delete(key);
    if (discoveries.size <= MAX_CACHE_ENTRIES) break;
  }
}
