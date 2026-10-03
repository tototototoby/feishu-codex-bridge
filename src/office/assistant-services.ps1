param(
  [ValidateSet('resume', 'pause', 'status')]
  [string]$Action = 'status',
  [string]$DataRoot,
  [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$runtimeDir = [IO.Path]::GetFullPath($PSScriptRoot)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $runtimeDir '..\..'))
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
  $DataRoot = if (-not [string]::IsNullOrWhiteSpace($env:FEISHU_CODEX_HOME)) { $env:FEISHU_CODEX_HOME } else { Join-Path $env:USERPROFILE '.feishu-codex-bridge' }
}
$DataRoot = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = if (-not [string]::IsNullOrWhiteSpace($env:FEISHU_CODEX_CONFIG)) { $env:FEISHU_CODEX_CONFIG } else { Join-Path $DataRoot 'config.json' }
}
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$sourcePrefix = $projectRoot.TrimEnd('\') + '\'
if ($DataRoot.Equals($projectRoot, [StringComparison]::OrdinalIgnoreCase) -or $DataRoot.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase) -or
    $ConfigPath.Equals($projectRoot, [StringComparison]::OrdinalIgnoreCase) -or $ConfigPath.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Private data and configuration must be outside the public source checkout.'
}

function Assert-NoReparsePath([string]$Path) {
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'private-path-reparse-point' }
    }
    $parent = Split-Path -Parent $cursor
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
}
function Resolve-ConfiguredTool([string]$Configured, [string]$DefaultName) {
  $candidate = if ([string]::IsNullOrWhiteSpace($Configured)) { $DefaultName } else { $Configured.Trim() }
  if ([IO.Path]::IsPathRooted($candidate)) { return [IO.Path]::GetFullPath($candidate) }
  $command = Get-Command -Name $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command -or [string]::IsNullOrWhiteSpace([string]$command.Source)) { throw 'configured-node-unavailable' }
  return [IO.Path]::GetFullPath([string]$command.Source)
}
function Get-TaskNamespace {
  $identity = ('{0}|{1}' -f [IO.Path]::GetFullPath($projectRoot), [IO.Path]::GetFullPath($DataRoot)).ToLowerInvariant()
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hex = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))).Replace('-', '') }
  finally { $sha.Dispose() }
  return 'Fcb-' + $hex.Substring(0, 12)
}

Assert-NoReparsePath $DataRoot
Assert-NoReparsePath $ConfigPath
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'Private project configuration was not found.' }
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.schemaVersion -ne 1 -or -not $config.assistants) { throw 'Private project configuration is invalid.' }
$configuredNode = ''
if ($config.PSObject.Properties['tools'] -and $config.tools -and $config.tools.PSObject.Properties['node']) {
  $configuredNode = [string]$config.tools.node
}
$nodePath = Resolve-ConfiguredTool $configuredNode 'node.exe'
$entryPath = Join-Path $runtimeDir 'office-entry.mjs'
$desktopGuardian = Join-Path $runtimeDir 'desktop-guardian.ps1'
$taskNamespace = Get-TaskNamespace
$env:FEISHU_CODEX_HOME = $DataRoot
$env:FEISHU_CODEX_CONFIG = $ConfigPath
$assistantBase = Join-Path $DataRoot 'assistants'
$assistantKeys = @($config.assistants.PSObject.Properties | ForEach-Object { [string]$_.Name } | Where-Object { $_ -match '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' -and $_ -notmatch '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])$' -and $_ -notin @('constructor', 'prototype', '__proto__') })

if ($Action -eq 'pause') {
  $failed = $false
  & $desktopGuardian stop -DataRoot $DataRoot -ConfigPath $ConfigPath | Out-Null
  if ($LASTEXITCODE -ne 0) { $failed = $true }
  foreach ($key in $assistantKeys) {
    & $nodePath $entryPath stop $key | Out-Null
    if ($LASTEXITCODE -ne 0) { $failed = $true }
  }
  if ($failed) { throw 'One or more office assistant stop actions were not confirmed.' }
} elseif ($Action -eq 'resume') {
  $failed = $false
  foreach ($key in $assistantKeys) {
    $definition = $config.assistants.PSObject.Properties[$key].Value
    $directory = if ([string]::IsNullOrWhiteSpace([string]$definition.directory)) { $key } else { [string]$definition.directory }
    if ($directory -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { continue }
    $assistantPath = Join-Path (Join-Path $assistantBase $directory) 'assistant.json'
    if (-not (Test-Path -LiteralPath $assistantPath -PathType Leaf)) { continue }
    $assistant = Get-Content -LiteralPath $assistantPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($assistant.enabled -eq $true -and $assistant.identityVerified -eq $true) {
      & $nodePath $entryPath start $key | Out-Null
      if ($LASTEXITCODE -ne 0) { $failed = $true }
    }
  }
  if ($config.desktop.enabled -eq $true) {
    & $desktopGuardian start -DataRoot $DataRoot -ConfigPath $ConfigPath | Out-Null
    if ($LASTEXITCODE -ne 0) { $failed = $true }
  }
  if ($failed) { throw 'One or more configured services could not be resumed.' }
} else {
  $names = @("FeishuAssistants.$taskNamespace.DesktopKeepAlive")
  foreach ($key in $assistantKeys) { $names += "FeishuOffice-$taskNamespace-$key" }
  Get-ScheduledTask -TaskName $names -ErrorAction SilentlyContinue |
    Select-Object TaskName, State, @{ n = 'Enabled'; e = { $_.Settings.Enabled } } | ConvertTo-Json -Depth 3
}
