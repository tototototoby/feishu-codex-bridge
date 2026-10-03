param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')]
    [string]$Assistant
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$sourceRoot = Join-Path $projectRoot 'node_modules\lark-channel-bridge'
$cliPath = Join-Path $sourceRoot 'dist\cli.js'
$packagePath = Join-Path $sourceRoot 'package.json'
$helperPath = Join-Path $PSScriptRoot 'create-profile-from-stdin.mjs'
$assistantKey = $Assistant
$dataRoot = if (-not [string]::IsNullOrWhiteSpace($env:FEISHU_CODEX_HOME)) { [IO.Path]::GetFullPath($env:FEISHU_CODEX_HOME) } else { Join-Path $env:USERPROFILE '.feishu-codex-bridge' }
$projectConfigPath = if (-not [string]::IsNullOrWhiteSpace($env:FEISHU_CODEX_CONFIG)) { [IO.Path]::GetFullPath($env:FEISHU_CODEX_CONFIG) } else { Join-Path $dataRoot 'config.json' }
$assistantBase = Join-Path $dataRoot 'assistants'
$projectConfig = $null
$definition = $null
$nodePath = $null
$codexPath = $null

function Resolve-ConfiguredTool([string]$Configured, [string]$DefaultName) {
    $candidate = if ([string]::IsNullOrWhiteSpace($Configured)) { $DefaultName } else { $Configured.Trim() }
    if ([IO.Path]::IsPathRooted($candidate)) { return [IO.Path]::GetFullPath($candidate) }
    $command = Get-Command -Name $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command -or [string]::IsNullOrWhiteSpace([string]$command.Source)) { throw '配置的可执行文件无法在本机解析。' }
    return [IO.Path]::GetFullPath([string]$command.Source)
}
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

try {
    Assert-PrivatePath $dataRoot
    Assert-PrivatePath $projectConfigPath
    if ($Assistant -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])$') { throw '助手标识符不可用。' }
    $projectConfig = Get-Content -LiteralPath $projectConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($projectConfig.schemaVersion -ne 1 -or -not $projectConfig.assistants) { throw '项目配置格式无效。' }
    $assistantProperty = $projectConfig.assistants.PSObject.Properties[$Assistant]
    if (-not $assistantProperty) { throw '项目配置中没有此助手。' }
    $sourceDefinition = $assistantProperty.Value
    $assistantDirectory = if ([string]::IsNullOrWhiteSpace([string]$sourceDefinition.directory)) { $Assistant } else { [string]$sourceDefinition.directory }
    $profile = if ([string]::IsNullOrWhiteSpace([string]$sourceDefinition.profile)) { $Assistant } else { [string]$sourceDefinition.profile }
    if ($assistantDirectory -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' -or $profile -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw '助手目录或 profile 标识符无效。' }
    $definition = @{
        DisplayName = [string]$sourceDefinition.displayName
        AppId = [string]$sourceDefinition.appId
        Profile = $profile
        Tenant = 'feishu'
        IntendedUserEmail = [string]$sourceDefinition.intendedUserEmail
        ExpectedTenantKey = [string]$sourceDefinition.expectedTenantKey
        IdentityVerificationMethod = if ([string]::IsNullOrWhiteSpace([string]$sourceDefinition.identityVerificationMethod)) { 'oauth-enterprise-email' } else { [string]$sourceDefinition.identityVerificationMethod }
        ExpectedUserUnionId = [string]$sourceDefinition.expectedUserUnionId
    }
    if ($definition.AppId -notmatch '^cli_[A-Za-z0-9_-]{8,128}$' -or [string]::IsNullOrWhiteSpace($definition.IntendedUserEmail) -or [string]::IsNullOrWhiteSpace($definition.ExpectedTenantKey)) { throw '应用、用户或租户绑定缺失。' }
    if ($definition.IdentityVerificationMethod -notin @('oauth-enterprise-email', 'oauth-union-id') -or
        ($definition.IdentityVerificationMethod -eq 'oauth-union-id' -and $definition.ExpectedUserUnionId -notmatch '^on_[A-Za-z0-9_-]{8,128}$')) { throw '身份核对绑定无效。' }
    $configuredNode = if ($projectConfig.tools -and $projectConfig.tools.PSObject.Properties['node']) { [string]$projectConfig.tools.node } else { '' }
    $configuredCodex = if ($projectConfig.tools -and $projectConfig.tools.PSObject.Properties['codex']) { [string]$projectConfig.tools.codex } else { '' }
    $nodePath = Resolve-ConfiguredTool $configuredNode 'node.exe'
    $codexPath = Resolve-ConfiguredTool $configuredCodex 'codex.cmd'
} catch {
    Write-Host '助手配置、用户绑定或本机工具路径无法安全确认。请检查私有配置后重试。'
    exit 2
}

$assistantRoot = Join-Path $assistantBase $assistantDirectory
$configPath = Join-Path $assistantRoot 'assistant.json'

try {
    Add-Type -AssemblyName PresentationFramework
    Add-Type -AssemblyName PresentationCore
    Add-Type -AssemblyName WindowsBase
    Add-Type -AssemblyName System.Xaml
} catch {
    Write-Host 'WPF 不可用，未启动凭证保存。'
    exit 2
}

function Get-FullPathString([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
        throw '配置路径不是绝对路径。'
    }
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-SamePath([string]$Left, [string]$Right) {
    return [string]::Equals((Get-FullPathString $Left), (Get-FullPathString $Right), [StringComparison]::OrdinalIgnoreCase)
}

try {
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw '应用配置文件不存在。'
    }
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $codexPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $cliPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $packagePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
        throw 'Node、Codex 或桥接程序路径不可用。'
    }

    $packageMetadata = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$packageMetadata.name -cne 'lark-channel-bridge' -or [string]$packageMetadata.version -cne '0.7.1') {
        throw '桥接程序版本不匹配。'
    }

    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $bridgeHome = Get-FullPathString ([string]$config.bridgeHome)
    $codexHome = Get-FullPathString ([string]$config.codexHome)
    $workspace = Get-FullPathString ([string]$config.workspace)
    $expectedRoot = Get-FullPathString $assistantRoot
    $assistantRoot = $expectedRoot

    if ([string]$config.appId -cne $definition.AppId -or
        [string]$config.profile -cne $definition.Profile -or
        [string]$config.tenant -cne $definition.Tenant -or
        [string]$config.expectedTenantKey -cne $definition.ExpectedTenantKey -or
        ([string]$config.intendedUserEmail).Trim().ToLowerInvariant() -cne $definition.IntendedUserEmail.Trim().ToLowerInvariant() -or
        [string]$config.identityVerificationMethod -cne $definition.IdentityVerificationMethod -or
        ([string]$config.expectedUserUnionId) -cne $definition.ExpectedUserUnionId -or
        $config.allowGroupMessages -ne $false -or
        [string]::IsNullOrWhiteSpace([string]$config.name) -or
        [string]::IsNullOrWhiteSpace([string]$config.intendedUserEmail) -or
        -not (Test-SamePath $bridgeHome (Join-Path $expectedRoot 'bridge')) -or
        -not (Test-SamePath $codexHome (Join-Path $expectedRoot 'codex')) -or
        -not (Test-SamePath $workspace (Join-Path $expectedRoot 'workspace'))) {
        throw '应用 ID、profile 或隔离路径与固定配置不匹配。'
    }
    if (-not (Test-Path -LiteralPath $bridgeHome -PathType Container) -or
        -not (Test-Path -LiteralPath $codexHome -PathType Container) -or
        -not (Test-Path -LiteralPath $workspace -PathType Container)) {
        throw '桥接、Codex 或工作区目录不存在。'
    }
    foreach ($privateDirectory in @($assistantRoot, $bridgeHome, $codexHome, $workspace)) {
        $privateItem = Get-Item -LiteralPath $privateDirectory -Force
        if (($privateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '助手隔离目录不能是 junction 或 symbolic link。' }
    }

} catch {
    [void][System.Windows.MessageBox]::Show(
        '保存窗口无法安全启动。请检查本机应用配置和安装路径后重试。',
        '未启动凭证保存',
        [System.Windows.MessageBoxButton]::OK,
        [System.Windows.MessageBoxImage]::Error
    )
    exit 2
}

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="保存应用凭证" Height="650" Width="790"
        MinHeight="620" MinWidth="740" ResizeMode="CanResize"
        WindowStartupLocation="CenterScreen" Background="#F5F7FA">
  <Grid Margin="24">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto" />
      <RowDefinition Height="Auto" />
      <RowDefinition Height="Auto" />
      <RowDefinition Height="Auto" />
      <RowDefinition Height="*" />
      <RowDefinition Height="Auto" />
    </Grid.RowDefinitions>
    <StackPanel Grid.Row="0" Margin="0,0,0,12">
      <TextBlock Text="保存飞书应用凭证" FontSize="24" FontWeight="SemiBold" Foreground="#172033" />
      <TextBlock Text="App Secret 通过本机 stdin 交给桥接程序；验证成功后会加密保存。不会启动机器人。"
                 Margin="0,6,0,0" TextWrapping="Wrap" Foreground="#536174" FontSize="13" />
    </StackPanel>
    <Border Grid.Row="1" Background="White" BorderBrush="#D7DEE8" BorderThickness="1" CornerRadius="8" Padding="16">
      <StackPanel>
        <TextBlock Text="应用 / 使用人" Foreground="#536174" />
        <TextBlock x:Name="DisplayNameBox" Margin="0,3,0,10" FontSize="17" FontWeight="SemiBold" Foreground="#172033" />
        <TextBlock Text="App ID" Foreground="#536174" />
        <TextBox x:Name="AppIdBox" IsReadOnly="True" Height="32" Margin="0,3,0,9" Padding="7" FontSize="13" FontFamily="Consolas" />
        <TextBlock Text="助手根目录" Foreground="#536174" />
        <TextBox x:Name="AssistantRootBox" IsReadOnly="True" Height="32" Margin="0,3,0,9" Padding="7" FontSize="12" FontFamily="Consolas" />
        <TextBlock Text="工作区" Foreground="#536174" />
        <TextBox x:Name="WorkspaceBox" IsReadOnly="True" Height="32" Margin="0,3,0,10" Padding="7" FontSize="12" FontFamily="Consolas" />
        <TextBlock Text="App Secret" Foreground="#536174" />
        <PasswordBox x:Name="SecretBox" MaxLength="1024" Height="36" Margin="0,3,0,0" Padding="7" FontSize="14" />
      </StackPanel>
    </Border>
    <Expander x:Name="AdvancedExpander" Grid.Row="2" Header="高级信息" IsExpanded="False" Margin="2,8,2,0" Foreground="#536174">
      <Border Background="White" BorderBrush="#D7DEE8" BorderThickness="1" CornerRadius="6" Padding="14" Margin="0,6,0,0">
        <StackPanel>
          <TextBlock Text="profile" Foreground="#536174" />
          <TextBox x:Name="ProfileBox" IsReadOnly="True" Margin="0,3,0,8" Padding="6" FontSize="12" FontFamily="Consolas" />
          <TextBlock Text="加密凭证文件" Foreground="#536174" />
          <TextBox x:Name="SecretTargetBox" IsReadOnly="True" TextWrapping="Wrap" Margin="0,3,0,8" Padding="6" FontSize="12" FontFamily="Consolas" />
          <TextBlock Text="LARK_CHANNEL_HOME" Foreground="#536174" />
          <TextBox x:Name="BridgeHomeBox" IsReadOnly="True" TextWrapping="Wrap" Margin="0,3,0,8" Padding="6" FontSize="12" FontFamily="Consolas" />
          <TextBlock Text="CODEX_HOME" Foreground="#536174" />
          <TextBox x:Name="CodexHomeBox" IsReadOnly="True" TextWrapping="Wrap" Margin="0,3,0,8" Padding="6" FontSize="12" FontFamily="Consolas" />
          <TextBlock Text="Node 可执行文件" Foreground="#536174" />
          <TextBox x:Name="NodePathBox" IsReadOnly="True" TextWrapping="Wrap" Margin="0,3,0,8" Padding="6" FontSize="12" FontFamily="Consolas" />
          <TextBlock Text="Codex 可执行文件" Foreground="#536174" />
          <TextBox x:Name="CodexPathBox" IsReadOnly="True" TextWrapping="Wrap" Margin="0,3,0,0" Padding="6" FontSize="12" FontFamily="Consolas" />
        </StackPanel>
      </Border>
    </Expander>
    <TextBlock x:Name="StatusText" Grid.Row="3" Text="请输入 App Secret，然后点击“校验并保存”。"
               Margin="2,10,2,8" TextWrapping="Wrap" Foreground="#536174" />
    <DockPanel Grid.Row="5" LastChildFill="False">
      <TextBlock Text="Secret 不会显示在屏幕、命令行、日志或普通输出中。" VerticalAlignment="Center" Foreground="#66758A" />
      <Button x:Name="SaveButton" Content="校验并保存" Width="150" Height="40" Padding="12,6"
              Margin="16,0,0,0" DockPanel.Dock="Right" IsDefault="True" FontWeight="SemiBold" />
    </DockPanel>
  </Grid>
</Window>
'@

try {
    $xmlReader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
    $window = [System.Windows.Markup.XamlReader]::Load($xmlReader)
    $displayNameBox = $window.FindName('DisplayNameBox')
    $appIdBox = $window.FindName('AppIdBox')
    $assistantRootBox = $window.FindName('AssistantRootBox')
    $profileBox = $window.FindName('ProfileBox')
    $secretTargetBox = $window.FindName('SecretTargetBox')
    $bridgeHomeBox = $window.FindName('BridgeHomeBox')
    $codexHomeBox = $window.FindName('CodexHomeBox')
    $workspaceBox = $window.FindName('WorkspaceBox')
    $nodePathBox = $window.FindName('NodePathBox')
    $codexPathBox = $window.FindName('CodexPathBox')
    $secretBox = $window.FindName('SecretBox')
    $statusText = $window.FindName('StatusText')
    $saveButton = $window.FindName('SaveButton')

    $applicationDisplay = '{0} · {1}' -f ([string]$config.name).Trim(), ([string]$config.intendedUserEmail).Trim()
    $window.Title = "$applicationDisplay · 保存应用凭证"
    $displayNameBox.Text = $applicationDisplay
    $appIdBox.Text = $definition.AppId
    $assistantRootBox.Text = $assistantRoot
    $profileBox.Text = $definition.Profile
    $bridgeHomeBox.Text = $bridgeHome
    $codexHomeBox.Text = $codexHome
    $workspaceBox.Text = $workspace
    $nodePathBox.Text = $nodePath
    $codexPathBox.Text = $codexPath

    $secretTarget = Join-Path (Join-Path (Join-Path $bridgeHome 'profiles') $definition.Profile) 'secrets.enc'
    $secretTargetBox.Text = $secretTarget
    if ((Test-Path -LiteralPath (Join-Path $bridgeHome 'config.json') -PathType Leaf) -or
        (Test-Path -LiteralPath (Join-Path $bridgeHome 'profiles') -PathType Container)) {
        $statusText.Text = '此隔离目录已存在桥接配置或 profile。为避免迁移、覆盖或重复写入，凭证保存已停用。'
        $saveButton.IsEnabled = $false
    }

    $script:bridgeProcess = $null
    $script:bridgeTimer = $null
    $script:bridgeStdoutTask = $null
    $script:bridgeStderrTask = $null
    $script:bridgeDeadline = $null
    $script:bridgeTimedOut = $false

    $saveButton.Add_Click({
        if ($script:bridgeProcess -or -not $saveButton.IsEnabled) { return }
        $secureSecret = $secretBox.SecurePassword
        if ($secureSecret.Length -lt 1 -or $secureSecret.Length -gt 1024) {
            $statusText.Text = 'App Secret 不能为空，长度上限为 1024 个字符。'
            $secureSecret.Dispose()
            return
        }

        $secretPointer = [IntPtr]::Zero
        $secretChars = $null
        $secretBytes = $null
        $process = $null
        try {
            $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
            $secretChars = New-Object 'System.Char[]' $secureSecret.Length
            for ($index = 0; $index -lt $secureSecret.Length; $index++) {
                $lowByte = [int][Runtime.InteropServices.Marshal]::ReadByte($secretPointer, $index * 2)
                $highByte = [int][Runtime.InteropServices.Marshal]::ReadByte($secretPointer, ($index * 2) + 1)
                $secretChars[$index] = [char]($lowByte -bor ($highByte -shl 8))
                $code = [int]$secretChars[$index]
                if ($code -lt 0x20 -or $code -eq 0x7f) {
                    throw '输入包含不可用的控制字符。'
                }
            }
            $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
            $secretBytes = [byte[]]$utf8.GetBytes([char[]]$secretChars)
            if ($secretBytes.Length -gt 4096) {
                throw '输入长度超过安全上限。'
            }

            $startInfo = New-Object System.Diagnostics.ProcessStartInfo
            $startInfo.FileName = $nodePath
            $startInfo.Arguments = '"' + $helperPath + '" "' + $assistantKey + '"'
            $startInfo.UseShellExecute = $false
            $startInfo.CreateNoWindow = $true
            $startInfo.RedirectStandardInput = $true
            $startInfo.RedirectStandardOutput = $true
            $startInfo.RedirectStandardError = $true

            $environment = $startInfo.EnvironmentVariables
            $environment.Clear()
            foreach ($name in @('SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'FEISHU_CODEX_HOME', 'FEISHU_CODEX_CONFIG')) {
                $value = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
                if (-not [string]::IsNullOrEmpty($value)) { $environment[$name] = $value }
            }
            $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot', [EnvironmentVariableTarget]::Process)
            if (-not [string]::IsNullOrEmpty($systemRoot)) {
                $environment['PATH'] = "$systemRoot\System32"
            }

            $process = New-Object System.Diagnostics.Process
            $process.StartInfo = $startInfo
            if (-not $process.Start()) { throw 'Node 进程启动失败。' }

            $script:bridgeProcess = $process
            $script:bridgeStdoutTask = $process.StandardOutput.ReadToEndAsync()
            $script:bridgeStderrTask = $process.StandardError.ReadToEndAsync()

            $inputStream = $process.StandardInput.BaseStream
            $inputStream.Write($secretBytes, 0, $secretBytes.Length)
            $inputStream.WriteByte(10)
            $inputStream.Flush()
            $process.StandardInput.Close()

            $script:bridgeDeadline = [DateTime]::UtcNow.AddSeconds(120)
            $script:bridgeTimedOut = $false
            $secretBox.Clear()
            $saveButton.IsEnabled = $false
            $statusText.Text = '正在通过飞书验证并加密保存。请等待结果；机器人不会启动。'

            $timer = New-Object System.Windows.Threading.DispatcherTimer
            $timer.Interval = [TimeSpan]::FromMilliseconds(250)
            $timer.Add_Tick({
                $activeProcess = $script:bridgeProcess
                if (-not $activeProcess) { return }
                if (-not $activeProcess.HasExited -and [DateTime]::UtcNow -ge $script:bridgeDeadline -and -not $script:bridgeTimedOut) {
                    $script:bridgeTimedOut = $true
                    try { $activeProcess.Kill() } catch { }
                }
                if (-not $activeProcess.HasExited) { return }

                $script:bridgeTimer.Stop()
                $status = 'failed'
                $credentialValidated = $null
                $encryptedProfileSaved = $null
                try {
                    $resultText = $script:bridgeStdoutTask.GetAwaiter().GetResult()
                    $null = $script:bridgeStderrTask.GetAwaiter().GetResult()
                    $result = $resultText | ConvertFrom-Json
                    $allowedStatuses = @('saved', 'validation-failed', 'profile-exists', 'codex-unavailable', 'config-invalid', 'input-rejected', 'failed')
                    if ($allowedStatuses -contains [string]$result.status) {
                        $status = [string]$result.status
                        $credentialValidated = $result.credentialValidated
                        $encryptedProfileSaved = $result.encryptedProfileSaved
                    }
                } catch { }

                if ($script:bridgeTimedOut) {
                    $statusText.Text = '操作超时，是否已保存无法确认。请勿立即重复提交；先检查此隔离目录并由管理员确认。'
                } elseif ($status -eq 'saved' -and $activeProcess.ExitCode -eq 0 -and $credentialValidated -eq $true -and $encryptedProfileSaved -eq $true) {
                    $statusText.Text = '飞书验证通过，App Secret 已加密保存到所示独立 profile。机器人未启动。'
                } elseif ($status -eq 'validation-failed') {
                    $statusText.Text = '飞书未通过凭证校验。原始诊断已隐藏；未创建 profile。'
                } elseif ($status -eq 'profile-exists') {
                    $statusText.Text = '此隔离桥接目录已有配置或 profile，没有重复写入凭证。'
                } elseif ($status -eq 'codex-unavailable') {
                    $statusText.Text = 'Codex 或工作区预检未通过。未开始凭证校验；请检查上方路径。'
                } elseif ($status -eq 'config-invalid' -or $status -eq 'input-rejected') {
                    $statusText.Text = '本机配置、桥接程序版本或输入校验未通过。未提交凭证。'
                } else {
                    $statusText.Text = '操作未能确认完成。原始诊断已隐藏；请勿立即重复提交，先检查隔离目录。'
                }

                $script:bridgeProcess.Dispose()
                $script:bridgeProcess = $null
                $script:bridgeStdoutTask = $null
                $script:bridgeStderrTask = $null
                $secretBox.Clear()
                $saveButton.IsEnabled = $true
            })
            $script:bridgeTimer = $timer
            $timer.Start()
        } catch {
            $secretBox.Clear()
            $saveButton.IsEnabled = $true
            $statusText.Text = '无法安全提交。原始诊断已隐藏；请确认本机安装路径后重试。'
            if ($process) {
                try { if (-not $process.HasExited) { $process.Kill() } } catch { }
                try { $process.Dispose() } catch { }
            }
            $script:bridgeProcess = $null
        } finally {
            if ($secretBytes) { [Array]::Clear($secretBytes, 0, $secretBytes.Length) }
            if ($secretChars) { [Array]::Clear($secretChars, 0, $secretChars.Length) }
            if ($secretPointer -ne [IntPtr]::Zero) {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
            }
            $secureSecret.Dispose()
        }
    })

    $window.Add_Closing({
        param($sender, $eventArgs)
        if ($script:bridgeProcess -and -not $script:bridgeProcess.HasExited) {
            $eventArgs.Cancel = $true
            $statusText.Text = '凭证校验仍在进行，请等待结果后再关闭窗口。'
        }
    })

    if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) {
        throw '此窗口必须在 STA 模式启动。'
    }
    [void]$window.ShowDialog()
} catch {
    [void][System.Windows.MessageBox]::Show(
        '保存窗口未能加载。原始诊断已隐藏。',
        '未启动凭证保存',
        [System.Windows.MessageBoxButton]::OK,
        [System.Windows.MessageBoxImage]::Error
    )
    exit 2
}
