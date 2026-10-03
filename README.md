# Feishu Codex Bridge

[English](README.en.md) · 中文

一个面向 Windows 的 Feishu/Lark 本地助手桥接项目：使用你自己的机器人应用，把私聊请求交给本机配置的助手档案处理，并以机器人身份回复。

> **v0.1.1 初始实验版本。** 这是一次公开源码抽取。全新环境的端到端安装与运行尚未验证。不要把它当作高可用服务；项目不承诺恰好执行一次、恰好送达或长期兼容。

## 功能与边界

- 每个助手使用独立的本地工作目录、Codex CLI 配置目录和桥接配置。
- 默认只处理发给机器人的一对一消息。群消息与群历史记录默认关闭。
- Feishu/Lark 运行时使用机器人身份；助手所有者的身份在设置阶段单独核验。
- 每个助手可选的可见记录镜像属于高级实验配置，需要单独的可信 Desktop 控制锚点；它不是自动导入侧边栏。
- `doctor` 检查本机依赖和配置，不会调用模型或发送消息。
- 办公助手默认使用进度与结果卡片，可用 `messageReply` 配置切换回复方式。
- 同一桌面聊天可启用 `desktop.notifyCompletion`：处理结束后另发新消息提醒，保留发送状态以避免重连重复发送。
- 可选的 Codex Desktop 适配器需要你另行安装的 Codex Desktop/App Tools，属于实验性、版本敏感功能；本仓库不包含 Desktop helper/plugin。详见 [Desktop 实验功能](docs/desktop-experimental.md)。

消息会按配置发送给 Feishu/Lark 和你所用的 Codex 服务。启用 Desktop 或可见记录功能时，所选内容还可能作为提示词发送到指定线程。不要把它理解为只在本机显示的纯日志。

## 环境要求

- Windows 10 或 11
- Node.js `22.13.0` 或更高版本，以及 npm
- 你自己的 Feishu/Lark 租户、机器人应用和应用发布权限
- 单独安装并登录的 Lark CLI 与 Codex CLI。二者需要在当前 PowerShell 的 `PATH` 中可用；身份与凭据使用你自己的账号。

机器人最小权限为 4 个机器人 scope 和 1 个员工 scope。具体用途、事件订阅及身份核验说明见[权限清单](docs/permissions.md)。

## 快速安装

```powershell
git clone https://github.com/tototototoby/feishu-codex-bridge.git
Set-Location .\feishu-codex-bridge
node --version
npm ci

# 可选：把私有数据放到 D 盘。必须在每次运行 CLI 前设置。
$env:FEISHU_CODEX_HOME = 'D:\FeishuCodexData'

node .\src\cli.mjs init
```

`init` 会在源码仓库外创建私有配置和运行目录，并显示配置文件位置。默认位置为 `%USERPROFILE%\.feishu-codex-bridge`；设置 `FEISHU_CODEX_HOME` 后使用指定目录。不要把私有数据目录放进源码仓库，也不要将它提交到 Git。

接下来在私有 `config.json` 中填写自己的应用与助手绑定。最小示例位于 [`examples/config.example.json`](examples/config.example.json)。完整设置顺序、配置字段和启动步骤见[安装与设置指南](docs/setup.md)。

助手条目的必填字段为 `displayName`、`appId`、`intendedUserEmail` 和 `expectedTenantKey`；`directory`、`profile`、`model`、`reasoningEffort` 可显式设置。以下仅为占位示例，不要照抄占位值：

```json
{
  "schemaVersion": 1,
  "tools": {},
  "assistants": {
    "assistant-1": {
      "displayName": "我的助手",
      "appId": "cli_REPLACE_WITH_YOUR_APP_ID",
      "intendedUserEmail": "owner@example.invalid",
      "expectedTenantKey": "REPLACE_WITH_YOUR_TENANT_KEY",
      "model": "gpt-6.1-sol",
      "reasoningEffort": "high"
    }
  }
}
```

Feishu/Lark 默认最小权限是：机器人 `im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:resource`、`cardkit:card:write`，以及仅用于设置阶段身份核验的员工 `contact:user.employee:readonly`。另外需启用机器人能力、订阅 `im.message.receive_v1` 长连接事件并发布应用版本。事件订阅不是 API scope；用户 OAuth 只用于设置时核验身份，收发消息由机器人身份完成。详见[权限清单](docs/permissions.md)。

## 常用命令

在项目目录运行：

```powershell
node .\src\cli.mjs doctor
node .\src\cli.mjs assistant init assistant-1
node .\src\cli.mjs office setup assistant-1
node .\src\cli.mjs office login-model assistant-1
node .\src\cli.mjs office-auth prepare assistant-1
node .\src\cli.mjs office-auth login assistant-1
node .\src\cli.mjs office-auth verify assistant-1
node .\src\cli.mjs office check-ready assistant-1
node .\src\cli.mjs office task-install assistant-1
node .\src\cli.mjs office start assistant-1
node .\src\cli.mjs office status assistant-1
node .\src\cli.mjs office stop assistant-1
```

CLI 命令不会自动替你创建或发布 Feishu 应用，也不会代替租户管理员批准 scope。只有完成权限、身份与本地助手设置后，才启动机器人。`assistant init` 创建的档案初始处于禁用状态。

运行 `office-auth prepare` 前，必须先按[设置指南第 5 步](docs/setup.md#5-explicitly-approve-owner-identity-setup)审阅并明确批准私有档案中的身份核验开关。然后在隔离的本地 profile 中完成一次用户身份登录并核验；运行时会恢复为机器人身份。核验成功后机器人仍保持禁用；只有人工检查核验结果并启用后才能启动。

## 安全与隐私

- 机器人运行使用机器人的身份。不要把用户 OAuth 身份当作机器人运行身份。
- 应用密钥通过 `office setup <key>` 的本地凭据流程输入；不要把密钥写入示例配置、提交到 Git 或贴进 issue。
- 预计所有者身份必须依据独立的权威通讯录记录核验。即使已授予员工 scope，`enterprise_email` 仍可能为空；此时按[权限清单](docs/permissions.md)从精确邮箱对应的唯一权威通讯录记录建立 union ID 基线，并确认应用与目录属于同一应用开发者/ISV union 命名空间。不能仅凭 tenant 相同或用待核验响应自行建立基线。
- 每个助手的目录隔离是同一 Windows 账号下的配置分离，不是 OS 级沙箱。同一账号下的其他进程可能访问这些目录。
- 示例配置默认关闭群历史、Desktop 和 commentary 转发。不要在未审查数据流及参与者告知的情况下开启。
- 飞书可见记录会作为实际提示词发送给目标助手线程；“只显示”文字无法保证模型绝不执行。
- `offline_access` 不是当前机器人运行所需权限，不要为此版本授予。

完整边界与数据说明见[安全模型](docs/security-model.md)和 [`SECURITY.md`](SECURITY.md)。

## 许可证

本项目新代码采用 MIT 许可证。派生自 `lark-channel-bridge@0.7.1` 的源代码保留上游 MIT 通知。直接依赖的实际许可证文本和 SPDX 清单见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 与 [`licenses/`](licenses/)。

欢迎通过 GitHub issue 或 pull request 报告问题和改进建议，提交前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
