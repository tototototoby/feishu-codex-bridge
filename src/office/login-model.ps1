param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')]
    [string]$Assistant
)

$ErrorActionPreference = 'Stop'
$runtimeRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $runtimeRoot '..\..'))

function Assert-PrivatePath([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $sourceRoot = [IO.Path]::GetFullPath($projectRoot).TrimEnd('\')
    if ([string]::Equals($fullPath, $sourceRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($sourceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '私有数据必须位于公开源码目录之外。' }
    $cursor = $fullPath
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '私有路径不能通过 junction 或 symbolic link 指向其他位置。' }
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
    if (-not $command -or [string]::IsNullOrWhiteSpace([string]$command.Source)) { throw '配置的 Codex 可执行文件无法在本机解析。' }
    return [IO.Path]::GetFullPath([string]$command.Source)
}

try {
    if ($Assistant -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])$') { throw '助手标识符不可用。' }
    $dataRoot = if (-not [string]::IsNullOrWhiteSpace($env:FEISHU_CODEX_HOME)) { [IO.Path]::GetFullPath($env:FEISHU_CODEX_HOME) } else { Join-Path $env:USERPROFILE '.feishu-codex-bridge' }
    $configPath = if (-not [string]::IsNullOrWhiteSpace($env:FEISHU_CODEX_CONFIG)) { [IO.Path]::GetFullPath($env:FEISHU_CODEX_CONFIG) } else { Join-Path $dataRoot 'config.json' }
    Assert-PrivatePath $dataRoot
    Assert-PrivatePath $configPath
    $projectConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($projectConfig.schemaVersion -ne 1) { throw '项目配置版本无效。' }
    $property = $projectConfig.assistants.PSObject.Properties[$Assistant]
    if (-not $property) { throw '项目配置中没有此助手。' }
    $definition = $property.Value
    $directory = if ([string]::IsNullOrWhiteSpace([string]$definition.directory)) { $Assistant } else { [string]$definition.directory }
    if ($directory -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw '助手目录标识符无效。' }
    $assistantRoot = Join-Path (Join-Path $dataRoot 'assistants') $directory
    $assistantConfig = Get-Content -LiteralPath (Join-Path $assistantRoot 'assistant.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedCodexDirectory = Join-Path $assistantRoot 'codex'
    $profile = if ([string]::IsNullOrWhiteSpace([string]$definition.profile)) { $Assistant } else { [string]$definition.profile }
    if ([IO.Path]::GetFullPath([string]$assistantConfig.codexHome) -ine [IO.Path]::GetFullPath($expectedCodexDirectory) -or
        [string]$assistantConfig.appId -cne [string]$definition.appId -or
        [string]$assistantConfig.profile -cne $profile -or [string]$assistantConfig.tenant -cne 'feishu' -or
        [string]$assistantConfig.expectedTenantKey -cne [string]$definition.expectedTenantKey -or
        ([string]$assistantConfig.intendedUserEmail).Trim().ToLowerInvariant() -cne ([string]$definition.intendedUserEmail).Trim().ToLowerInvariant()) {
        throw '模型账户目录或应用绑定不匹配。'
    }
    foreach ($privateDirectory in @($assistantRoot, $expectedCodexDirectory)) {
        $privateItem = Get-Item -LiteralPath $privateDirectory -Force
        if (($privateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '助手模型目录不能是 junction 或 symbolic link。' }
    }
    $configuredCodex = if ($projectConfig.tools -and $projectConfig.tools.PSObject.Properties['codex']) { [string]$projectConfig.tools.codex } else { '' }
    $codexBinary = Resolve-ConfiguredTool $configuredCodex 'codex.cmd'
    if (-not (Test-Path -LiteralPath $codexBinary -PathType Leaf)) { throw 'Codex CLI 不可用。' }
} catch {
    Write-Error '助手配置或 Codex CLI 无法安全确认。'
    exit 2
}

foreach ($entry in [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).Keys) {
    if ([string]$entry -match '^(LARK|FEISHU|OPENCLAW|HERMES|CODEX_)') {
        [Environment]::SetEnvironmentVariable([string]$entry, $null, [EnvironmentVariableTarget]::Process)
    }
}
$env:CODEX_HOME = $expectedCodexDirectory
Write-Host ('正在为 {0} 登录模型服务。' -f $assistantConfig.name)
Write-Host ('认证目录：{0}' -f $expectedCodexDirectory)
Write-Host '请使用准备为这个助手提供模型服务的 ChatGPT 账户完成正常登录。飞书用户授权会单独处理。'
& $codexBinary login --device-auth
if ($LASTEXITCODE -ne 0) { throw '模型账户登录尚未完成。' }
& $codexBinary login status
if ($LASTEXITCODE -ne 0) { throw '未确认模型账户已登录。' }
Write-Host '模型服务登录完成。可以关闭此窗口。'
Read-Host '按 Enter 关闭' | Out-Null
