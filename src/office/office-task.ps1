param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('status', 'start', 'stop', 'run', 'register-disabled')]
  [string]$Action,
  [Parameter(Mandatory = $true, Position = 1)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')]
  [string]$AssistantKey,
  [Parameter(Mandatory = $true)] [string]$OfficeRoot,
  [Parameter(Mandatory = $true)] [string]$RuntimeRoot,
  [Parameter(Mandatory = $true)] [string]$NodePath,
  [Parameter(Mandatory = $true)] [string]$DataRoot,
  [Parameter(Mandatory = $true)] [string]$ConfigPath,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^Fcb-[A-Fa-f0-9]{12}$')]
  [string]$TaskNamespace
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$runtimeDir = [IO.Path]::GetFullPath($RuntimeRoot)
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$privateRoot = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
$officeRoot = [IO.Path]::GetFullPath($OfficeRoot).TrimEnd('\')
$configPath = [IO.Path]::GetFullPath($ConfigPath)
$nodePath = [IO.Path]::GetFullPath($NodePath)
$entryPath = Join-Path $runtimeDir 'office-entry.mjs'
$scriptPath = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$taskName = "FeishuOffice-$TaskNamespace-$AssistantKey"
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid = $currentIdentity.User.Value
$currentUser = $currentIdentity.Name
$pinnedPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$powerShellPath = $pinnedPowerShell
$assistantRoot = $null
$assistantConfigPath = $null
$bridgeHome = $null
$logDirectory = $null
$taskArguments = $null
$autostartDisabled = $false
$schedule = New-Object -ComObject 'Schedule.Service'
$schedule.Connect()
$folder = $schedule.GetFolder('\')

function Test-PathInside([string]$Parent, [string]$Child) {
  $prefix = $Parent.TrimEnd('\') + '\'
  return $Child.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
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
function Same-Path([string]$Left, [string]$Right) {
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  try { return [string]::Equals([IO.Path]::GetFullPath($Left).TrimEnd('\'), [IO.Path]::GetFullPath($Right).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }
  catch { return $false }
}
function Resolve-AccountSid([string]$accountName) {
  if ([string]::IsNullOrWhiteSpace($accountName)) { return '' }
  if ($accountName -match '^S-1-[0-9]+(?:-[0-9]+)+$') { return $accountName }
  try { return [Security.Principal.NTAccount]::new($accountName).Translate([Security.Principal.SecurityIdentifier]).Value }
  catch { return '' }
}
function Get-ManagedTask {
  return Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
function Protect-LogDirectory {
  if (Test-Path -LiteralPath $logDirectory) {
    $item = Get-Item -LiteralPath $logDirectory -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unsafe-log-directory' }
  } else { New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null }

  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  & $icacls $logDirectory '/inheritance:r' '/grant:r' ("*${currentSid}:(OI)(CI)F") '*S-1-5-18:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'log-directory-dacl-failed' }
  $actualAcl = Get-Acl -LiteralPath $logDirectory
  foreach ($rule in $actualAcl.Access) {
    $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $ruleSid -notin @($currentSid, 'S-1-5-18')) { throw 'log-directory-dacl-not-private' }
  }
}
function Assert-TaskBinding($task) {
  if ($null -eq $task) { return }
  if (@($task.Actions).Count -ne 1 -or @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' }).Count -lt 1) { throw 'task-shape-mismatch' }
  $scheduledAction = $task.Actions[0]
  $principal = $task.Principal
  $trigger = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })[0]
  $principalSid = Resolve-AccountSid ([string]$principal.UserId)
  $triggerSid = Resolve-AccountSid ([string]$trigger.UserId)
  if (-not (Same-Path $scheduledAction.Execute $powerShellPath) -or
      [string]$scheduledAction.Arguments -cne $taskArguments -or
      -not (Same-Path $scheduledAction.WorkingDirectory $runtimeDir) -or
      -not [string]::Equals($principalSid, $currentSid, [StringComparison]::OrdinalIgnoreCase) -or
      [string]$principal.LogonType -ne 'Interactive' -or [string]$principal.RunLevel -ne 'Limited' -or
      -not [string]::Equals($triggerSid, $currentSid, [StringComparison]::OrdinalIgnoreCase) -or
      $task.Settings.Hidden -ne $true -or [string]$task.Settings.MultipleInstances -ne 'IgnoreNew' -or
      [int]$task.Settings.RestartCount -lt 1) { throw 'task-binding-mismatch' }
}
function Emit-Result($ok, $state, $errorCode = $null) {
  $task = Get-ManagedTask
  $result = [ordered]@{
    schemaVersion = 1; ok = [bool]$ok; action = $Action; assistantKey = $AssistantKey
    taskName = $taskName; exists = [bool]$task; enabled = [bool]($task -and $task.Settings.Enabled)
    autostartDisabled = [bool]$autostartDisabled; state = [string]$state
    sidMatches = [bool](-not $task -or [string]::Equals((Resolve-AccountSid ([string]$task.Principal.UserId)), $currentSid, [StringComparison]::OrdinalIgnoreCase))
  }
  if ($errorCode) { $result.errorCode = [string]$errorCode }
  [pscustomobject]$result | ConvertTo-Json -Compress -Depth 3
}

try {
  if ($AssistantKey -in @('constructor', 'prototype', '__proto__')) { throw 'assistant-key-reserved' }
  if (-not (Same-Path $runtimeDir $PSScriptRoot) -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $powerShellPath -PathType Leaf) -or -not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
    throw 'runtime-unavailable'
  }
  if ((Same-Path $sourceRoot $privateRoot) -or (Test-PathInside $sourceRoot $privateRoot)) { throw 'private-data-inside-source' }
  if ((Same-Path $sourceRoot $configPath) -or (Test-PathInside $sourceRoot $configPath)) { throw 'private-config-inside-source' }
  Assert-NoReparsePath $privateRoot
  Assert-NoReparsePath $configPath
  if (-not (Same-Path $officeRoot (Join-Path $privateRoot 'assistants'))) { throw 'office-root-mismatch' }
  Assert-NoReparsePath $officeRoot
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'project-config-unavailable' }
  $projectConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($projectConfig.schemaVersion -ne 1) { throw 'project-config-invalid' }
  $assistantProperty = $projectConfig.assistants.PSObject.Properties[$AssistantKey]
  if (-not $assistantProperty) { throw 'assistant-not-configured' }
  $assistantDirectory = if ([string]::IsNullOrWhiteSpace([string]$assistantProperty.Value.directory)) { $AssistantKey } else { [string]$assistantProperty.Value.directory }
  if ($assistantDirectory -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw 'assistant-directory-invalid' }
  $assistantRoot = Join-Path $officeRoot $assistantDirectory
  $assistantConfigPath = Join-Path $assistantRoot 'assistant.json'
  if (-not (Test-Path -LiteralPath $assistantConfigPath -PathType Leaf)) {
    throw 'assistant-config-unavailable'
  }
  $assistantConfig = Get-Content -LiteralPath $assistantConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $expectedRoot = [IO.Path]::GetFullPath($assistantRoot).TrimEnd('\')
  $bridgeHome = Join-Path $expectedRoot 'bridge'
  $codexHome = Join-Path $expectedRoot 'codex'
  $workspace = Join-Path $expectedRoot 'workspace'
  if (-not (Same-Path $assistantConfig.bridgeHome $bridgeHome) -or -not (Same-Path $assistantConfig.codexHome $codexHome) -or
      -not (Same-Path $assistantConfig.workspace $workspace) -or $assistantConfig.allowGroupMessages -ne $false) { throw 'assistant-path-mismatch' }
  foreach ($path in @($expectedRoot, $bridgeHome, $codexHome, $workspace)) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw 'assistant-directory-unavailable' }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'assistant-directory-reparse-point' }
  }
  $logDirectory = Join-Path $bridgeHome 'office-runtime-logs'
  $taskArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" run "{1}" -OfficeRoot "{2}" -RuntimeRoot "{3}" -NodePath "{4}" -DataRoot "{5}" -ConfigPath "{6}" -TaskNamespace "{7}"' -f $scriptPath, $AssistantKey, $officeRoot, $runtimeDir, $nodePath, $privateRoot, $configPath, $TaskNamespace
  $task = Get-ManagedTask

  if ($Action -eq 'run') {
    if (-not $task) { throw 'task-not-registered' }
    Assert-TaskBinding $task
    if (-not $task.Enabled) { throw 'task-disabled' }
    $env:FEISHU_CODEX_HOME = $privateRoot
    $env:FEISHU_CODEX_CONFIG = $configPath
    Protect-LogDirectory
    $nodeArguments = '"{0}" serve "{1}"' -f $entryPath, $AssistantKey
    $runStamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')
    $process = Start-Process -FilePath $nodePath -ArgumentList $nodeArguments -WorkingDirectory $runtimeDir -WindowStyle Hidden -Wait -PassThru `
      -RedirectStandardOutput (Join-Path $logDirectory ("supervisor-$runStamp.stdout.log")) `
      -RedirectStandardError (Join-Path $logDirectory ("supervisor-$runStamp.stderr.log"))
    exit [int]$process.ExitCode
  }

  if ($Action -eq 'status') {
    if ($task) { Assert-TaskBinding $task }
    Emit-Result $true $(if ($task) { [string]$task.State } else { 'Missing' })
    exit 0
  }

  if ($Action -eq 'start' -or $Action -eq 'register-disabled') {
    if ($Action -eq 'start') {
      $env:FEISHU_CODEX_HOME = $privateRoot
      $env:FEISHU_CODEX_CONFIG = $configPath
      $null = & $nodePath $entryPath 'check-ready' $AssistantKey 2>$null
      if ($LASTEXITCODE -ne 0) { Emit-Result $false 'ReadyBlocked' 'assistant-not-ready'; exit 3 }
    }
    Protect-LogDirectory
    if ($task) { Assert-TaskBinding $task }
    else {
      $scheduledAction = New-ScheduledTaskAction -Execute $powerShellPath -Argument $taskArguments -WorkingDirectory $runtimeDir
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
      $principal = New-ScheduledTaskPrincipal -UserId $currentSid -LogonType Interactive -RunLevel Limited
      $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Hidden
      Register-ScheduledTask -TaskName $taskName -Action $scheduledAction -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
      $task = Get-ManagedTask
      Assert-TaskBinding $task
    }
    if ($Action -eq 'register-disabled') {
      if ($task.State -eq 'Running') { throw 'refusing-to-disable-running-assistant' }
      if ($task.Settings.Enabled) { Disable-ScheduledTask -TaskName $taskName | Out-Null }
      $autostartDisabled = $true
      Emit-Result $true 'Disabled'
      exit 0
    }
    if (-not $task.Settings.Enabled) { Enable-ScheduledTask -TaskName $taskName | Out-Null }
    $task = Get-ManagedTask
    if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $taskName | Out-Null }
    $task = Get-ManagedTask
    Emit-Result $true $(if ($task) { [string]$task.State } else { 'Missing' })
    exit 0
  }

  if ($Action -eq 'stop') {
    if (-not $task) { $autostartDisabled = $true; Emit-Result $true 'Missing'; exit 0 }
    $wasRunning = $task.State -eq 'Running'
    Assert-TaskBinding $task
    if ($task.Settings.Enabled) { Disable-ScheduledTask -TaskName $taskName | Out-Null }
    $task = Get-ManagedTask
    if (-not $task -or $task.Settings.Enabled) { throw 'task-not-disabled' }
    $autostartDisabled = $true
    if ($wasRunning) { Stop-ScheduledTask -TaskName $taskName | Out-Null }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do { Start-Sleep -Milliseconds 250; $task = Get-ManagedTask; if (-not $task -or $task.State -ne 'Running') { break } }
    while ([DateTime]::UtcNow -lt $deadline)
    if ($task -and $task.State -eq 'Running') { throw 'task-stop-timeout' }
    Emit-Result $true $(if ($task) { [string]$task.State } else { 'Missing' })
    exit 0
  }
} catch {
  $safeCode = if ($_.Exception.Message -match '^[a-z0-9-]{1,64}$') { $_.Exception.Message } else { 'task-controller-failed' }
  Emit-Result $false 'Error' $safeCode
  exit 10
}
