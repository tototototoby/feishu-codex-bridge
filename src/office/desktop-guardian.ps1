param(
  [ValidateSet('start', 'run', 'stop', 'status')]
  [string]$Action = 'status',
  [string]$DataRoot,
  [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$runtimeRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $runtimeRoot '..\..'))
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
function Get-TaskNamespace {
  $identity = ('{0}|{1}' -f [IO.Path]::GetFullPath($projectRoot), [IO.Path]::GetFullPath($DataRoot)).ToLowerInvariant()
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hex = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))).Replace('-', '') }
  finally { $sha.Dispose() }
  return 'Fcb-' + $hex.Substring(0, 12)
}
function Read-ProjectConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'Private project configuration was not found.' }
  Assert-NoReparsePath $DataRoot
  Assert-NoReparsePath $ConfigPath
  $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($config.schemaVersion -ne 1 -or -not $config.assistants) { throw 'Private project configuration is invalid.' }
  return $config
}
function Get-ManagedTask([string]$Name) {
  return Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
}
function Write-GuardianStatus([string]$State, $Details) {
  $directory = Join-Path $DataRoot 'desktop'
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  $directoryItem = Get-Item -LiteralPath $directory -Force
  if (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'desktop-state-directory-reparse-point' }
  $statusPath = Join-Path $directory 'desktop-guardian-status.json'
  $data = [ordered]@{ at = [DateTimeOffset]::Now.ToString('o'); state = $State; details = $Details }
  $temporary = $statusPath + '.' + $PID + '.tmp'
  [IO.File]::WriteAllText($temporary, ($data | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $statusPath -Force
}
function Find-DesktopMain($Package, [string]$ProcessName) {
  $trustedRoots = @((Split-Path -Parent $Package.InstallLocation), (Join-Path $env:ProgramFiles 'WindowsApps')) | Select-Object -Unique
  foreach ($candidate in @(Get-CimInstance Win32_Process -Filter ("Name='" + $ProcessName.Replace("'", "''") + "'"))) {
    if ($candidate.CommandLine -match '(?:^|\s)--type(?:=|\s)') { continue }
    $trusted = $false
    foreach ($root in $trustedRoots) {
      if ($candidate.ExecutablePath.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $trusted = $true }
    }
    if (-not $trusted) { continue }
    $owner = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid
    if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $currentSid) { return $candidate }
  }
  return $null
}
function Write-TaskStatus($Task) {
  [pscustomobject]@{ task = $taskName; enabled = [bool]($Task -and $Task.Enabled); state = if ($Task) { $Task.State } else { 0 } } | ConvertTo-Json -Compress
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid = $identity.User.Value
$taskNamespace = Get-TaskNamespace
$taskName = "FeishuAssistants.$taskNamespace.DesktopKeepAlive"
$scriptPath = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$statusDirectory = Join-Path $DataRoot 'desktop'
$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$schedule = New-Object -ComObject 'Schedule.Service'
$schedule.Connect()
$folder = $schedule.GetFolder('\')
$projectConfig = Read-ProjectConfig
$desktopConfig = $projectConfig.desktop
$task = Get-ManagedTask $taskName

if ($Action -eq 'run') {
  if ($desktopConfig.enabled -ne $true) { Write-GuardianStatus 'paused-by-configuration' @{}; exit }
  $packageName = if ($desktopConfig.packageName) { [string]$desktopConfig.packageName } else { 'OpenAI.Codex' }
  $familyName = if ($desktopConfig.packageFamilyName) { [string]$desktopConfig.packageFamilyName } else { 'OpenAI.Codex_2p2nqsd0c76g0' }
  $activationId = if ($desktopConfig.activationId) { [string]$desktopConfig.activationId } else { 'OpenAI.Codex_2p2nqsd0c76g0!App' }
  $processName = if ($desktopConfig.processName) { [string]$desktopConfig.processName } else { 'ChatGPT.exe' }
  $lastLaunch = [DateTimeOffset]::MinValue
  $missingSince = $null
  $lastTaskStarts = @{}
  while ($true) {
    try {
      $enabledTasks = @()
      foreach ($assistantProperty in $projectConfig.assistants.PSObject.Properties) {
        $key = [string]$assistantProperty.Name
        if ($key -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' -or $key -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])$' -or $key -in @('constructor', 'prototype', '__proto__')) { continue }
        $definition = $assistantProperty.Value
        $assistantDirectory = if ([string]::IsNullOrWhiteSpace([string]$definition.directory)) { $key } else { [string]$definition.directory }
        if ($assistantDirectory -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { continue }
        $assistantPath = Join-Path (Join-Path (Join-Path $DataRoot 'assistants') $assistantDirectory) 'assistant.json'
        if (-not (Test-Path -LiteralPath $assistantPath -PathType Leaf)) { continue }
        $assistantConfig = Get-Content -LiteralPath $assistantPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $emailMatches = ([string]$assistantConfig.intendedUserEmail).Trim().ToLowerInvariant() -ceq ([string]$definition.intendedUserEmail).Trim().ToLowerInvariant()
        $identityMethod = if ([string]::IsNullOrWhiteSpace([string]$definition.identityVerificationMethod)) { 'oauth-enterprise-email' } else { [string]$definition.identityVerificationMethod }
        $unionMatches = $identityMethod -ne 'oauth-union-id' -or
          ([string]$assistantConfig.expectedUserUnionId -ceq [string]$definition.expectedUserUnionId -and [string]$assistantConfig.verifiedUserUnionId -ceq [string]$definition.expectedUserUnionId)
        if ($assistantConfig.enabled -ne $true -or $assistantConfig.identityVerified -ne $true -or
            $assistantConfig.appId -cne $definition.appId -or $assistantConfig.verifiedAppId -cne $definition.appId -or
            $assistantConfig.expectedTenantKey -cne $definition.expectedTenantKey -or $assistantConfig.verifiedTenantKey -cne $definition.expectedTenantKey -or
            $assistantConfig.identityVerificationMethod -cne $identityMethod -or -not $unionMatches -or
            -not $emailMatches -or -not ([string]$assistantConfig.verifiedEnterpriseEmail).Trim().Equals(([string]$definition.intendedUserEmail).Trim(), [StringComparison]::OrdinalIgnoreCase) -or
            [string]$assistantConfig.allowedOpenId -notmatch '^ou_[A-Za-z0-9_-]{8,128}$' -or $assistantConfig.allowGroupMessages -ne $false) { continue }
        $name = "FeishuOffice-$taskNamespace-$key"
        $assistantTask = Get-ManagedTask $name
        if (-not $assistantTask -or -not $assistantTask.Enabled) { continue }
        $enabledTasks += $name
        $now = [DateTimeOffset]::Now
        if ($assistantTask.State -ne 4 -and (-not $lastTaskStarts.ContainsKey($name) -or ($now - $lastTaskStarts[$name]).TotalSeconds -ge 60)) {
          [void]$assistantTask.Run($null)
          $lastTaskStarts[$name] = $now
        }
      }
      if ($enabledTasks.Count -eq 0) {
        Write-GuardianStatus 'paused-no-enabled-assistants' @{}
      } else {
        $packages = @(Get-AppxPackage -Name $packageName | Where-Object PackageFamilyName -eq $familyName)
        if ($packages.Count -ne 1) { throw 'registered-desktop-package-unavailable' }
        $desktop = Find-DesktopMain $packages[0] $processName
        if ($desktop) {
          $missingSince = $null
          Write-GuardianStatus 'desktop-running' @{ pid = [int]$desktop.ProcessId; assistantTasksEnabled = $enabledTasks.Count }
        } else {
          $now = [DateTimeOffset]::Now
          if ($null -eq $missingSince) { $missingSince = $now }
          if (($now - $missingSince).TotalSeconds -ge 15 -and ($now - $lastLaunch).TotalSeconds -ge 90) {
            Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ("shell:AppsFolder\" + $activationId) -WindowStyle Hidden
            $lastLaunch = $now
            Write-GuardianStatus 'desktop-launch-requested' @{ activationId = $activationId }
          } else { Write-GuardianStatus 'waiting-for-desktop' @{} }
        }
      }
    } catch {
      Write-GuardianStatus 'recovery-waiting' @{ code = 'package-or-task-unavailable'; errorType = $_.Exception.GetType().FullName; errorId = $_.FullyQualifiedErrorId; line = $_.InvocationInfo.ScriptLineNumber }
    }
    Start-Sleep -Seconds 15
  }
  exit
}

if ($Action -eq 'start' -and $desktopConfig.enabled -ne $true) {
  Write-TaskStatus $task
  exit 0
}
if ($Action -eq 'start') {
  $definition = $schedule.NewTask(0)
  $definition.RegistrationInfo.Description = 'Keep the configured current-user Codex desktop available for enabled office assistants.'
  $definition.Principal.UserId = $currentSid
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0
  $definition.Settings.Enabled = $true
  $definition.Settings.Hidden = $true
  $definition.Settings.ExecutionTimeLimit = 'PT0S'
  $definition.Settings.MultipleInstances = 2
  $definition.Settings.DisallowStartIfOnBatteries = $false
  $definition.Settings.StopIfGoingOnBatteries = $false
  $definition.Settings.StartWhenAvailable = $true
  $definition.Settings.RestartCount = 10
  $definition.Settings.RestartInterval = 'PT1M'
  $trigger = $definition.Triggers.Create(9)
  $trigger.UserId = $currentSid
  $trigger.Delay = 'PT5S'
  $actionItem = $definition.Actions.Create(0)
  $actionItem.Path = $powerShellPath
  $actionItem.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" run -DataRoot "{1}" -ConfigPath "{2}"' -f $scriptPath, $DataRoot, $ConfigPath
  $actionItem.WorkingDirectory = $runtimeRoot
  if ($task -and $task.State -eq 4) { $task.Stop(0) }
  $task = $folder.RegisterTaskDefinition($taskName, $definition, 6, $currentSid, $null, 3, $null)
  [void]$task.Run($null)
} elseif ($Action -eq 'stop' -and $task) {
  $task.Enabled = $false
  if ($task.State -eq 4) { $task.Stop(0) }
}
Write-TaskStatus $task
