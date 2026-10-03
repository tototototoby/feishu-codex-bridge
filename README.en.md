# Feishu Codex Bridge

[简体中文](README.md) · English

A Windows-first Feishu/Lark assistant bridge. It uses a bot application you
control to route direct-message requests to locally configured assistant
profiles and reply as the bot.

> **Initial experimental release: v0.1.0.** This is a public source
> extraction. A clean end-to-end installation and run have not been verified.
> Do not treat this as a high-availability service; exactly-once execution,
> exactly-once delivery, and long-term compatibility are not promised.

## What it does

- Gives each assistant a separate local workspace, Codex CLI home, and bridge
  configuration.
- Handles bot direct messages by default. Group messages and group history are
  disabled in the example configuration.
- Uses the bot identity at runtime and verifies the intended owner separately
  during setup.
- Offers an advanced, experimental per-assistant visibility mirror that
  requires a separate trusted Desktop control anchor; it is not an automatic
  sidebar import.
- Provides a `doctor` command for local prerequisite and configuration checks;
  it does not call a model or send a message.
- Offers an optional Codex Desktop adapter that depends on your separately
  installed Codex Desktop/App Tools component. It is experimental and
  version-sensitive. This repository does not bundle the Desktop helper or
  plugin. See [Desktop integration](docs/desktop-experimental.md).

Messages are sent to Feishu/Lark and the Codex service selected in your setup.
When Desktop or visibility features are enabled, selected content can also be
sent as prompts to a configured thread. Do not treat that as local-only logging.

## Requirements

- Windows 10 or 11
- Node.js `22.13.0` or newer and npm
- Your own Feishu/Lark tenant, bot application, and permission to publish it
- Separately installed and authenticated Lark CLI and Codex CLI, available on
  the current PowerShell `PATH`. Use your own accounts and credentials.

The minimum bot configuration uses four bot scopes and one employee scope. See
the [permission checklist](docs/permissions.md) for the exact scopes, event
subscription, and identity setup.

## Install

```powershell
git clone https://github.com/tototototoby/feishu-codex-bridge.git
Set-Location .\feishu-codex-bridge
node --version
npm ci

# Optional: put private data on D:. Set this before every CLI invocation.
$env:FEISHU_CODEX_HOME = 'D:\FeishuCodexData'

node .\src\cli.mjs init
```

`init` creates private configuration and runtime directories outside the
source checkout and prints the config path. The default is
`%USERPROFILE%\.feishu-codex-bridge`; `FEISHU_CODEX_HOME` selects another
directory. Do not place private data inside the repository or commit it.

Edit the private `config.json` with your app and assistant bindings. A minimal
example is in [`examples/config.example.json`](examples/config.example.json).
See the complete [setup guide](docs/setup.md) for fields, identity checks, and
startup order.

Each assistant entry requires `displayName`, `appId`, `intendedUserEmail`, and
`expectedTenantKey`; `directory`, `profile`, `model`, and `reasoningEffort` can
also be set. The following is only a placeholder example:

```json
{
  "schemaVersion": 1,
  "tools": {},
  "assistants": {
    "assistant-1": {
      "displayName": "My assistant",
      "appId": "cli_REPLACE_WITH_YOUR_APP_ID",
      "intendedUserEmail": "owner@example.invalid",
      "expectedTenantKey": "REPLACE_WITH_YOUR_TENANT_KEY",
      "model": "gpt-6.1-sol",
      "reasoningEffort": "high"
    }
  }
}
```

The default minimum Feishu/Lark permissions are bot scopes
`im:message.p2p_msg:readonly`, `im:message:send_as_bot`, `im:resource`, and
`cardkit:card:write`, plus the employee scope
`contact:user.employee:readonly` used only for setup-time identity checks.
Enable the bot capability, subscribe to the `im.message.receive_v1`
long-connection event, and publish an app version. The event subscription is
not an API scope. User OAuth is only for setup-time identity verification;
runtime messaging uses the bot identity. See the [permission checklist](docs/permissions.md).

## Common commands

Run from the project directory:

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

The CLI does not create or publish a Feishu app or grant tenant permissions.
Start the bot only after app permissions, owner verification, and local profile
setup are complete. A profile created by `assistant init` starts disabled.
Before `office-auth prepare`, review and explicitly approve the private profile
identity-check gate as described in [setup step 5](docs/setup.md#5-explicitly-approve-owner-identity-setup).
Then sign in to the profile-local user identity and verify it; runtime is
restored to the bot identity. Successful verification still leaves the bot
disabled until you review and enable the profile.

## Security and privacy

- Runtime messaging uses the bot identity. Do not use a user OAuth identity as
  the bot's runtime identity.
- Enter the app secret through the local `office setup <key>` credential flow.
  Do not place it in an example config, commit it, or paste it into an issue.
- Verify the expected owner against an independent authoritative directory
  record. `enterprise_email` can be empty even when the employee scope is
  granted. In that case, establish the union ID baseline from the unique
  authoritative directory record for the exact intended email, and confirm
  the app and directory use the same application developer/ISV union
  namespace. A matching tenant alone is insufficient; never use the candidate
  response to establish its own baseline.
- Assistant directories are separated by configuration under one Windows
  account, not by OS-level sandboxing. Other processes running as that account
  may be able to access them.
- Group history, Desktop, and commentary forwarding are disabled in the sample
  config. Review the data flow and inform participants before enabling them.
- Feishu visibility records are actual prompts sent to the target assistant
  thread. A “display only” instruction cannot guarantee that the model will
  take no action.
- `offline_access` is not required for this release's bot runtime.

Read the [security model](docs/security-model.md) and [`SECURITY.md`](SECURITY.md)
for data handling and reporting instructions.

## License

New project code is licensed under MIT. Source derived from
`lark-channel-bridge@0.7.1` retains the upstream MIT notice. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and [`licenses/`](licenses/)
for the copied dependency license texts and SPDX inventory.

Issues and pull requests are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md)
before contributing.
