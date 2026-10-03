# Windows setup guide

This guide describes the intended `v0.1.2` setup flow. A clean-install,
end-to-end run has not been verified. Use a Feishu/Lark tenant and Codex
account that you control, and start with a test bot and non-sensitive messages.

## Native Windows execution permissions

Configure the native Windows sandbox in each assistant's private Codex home,
separately from the Desktop application's home. A workspace permission in the
bridge does not prove that the installed Codex build resolves the same effective
sandbox. On an observed native build, an assistant home without a selected
Windows sandbox resolved to read-only despite requesting workspace-write.

For the supported fallback implementation and authorized online Feishu work,
the assistant's private `codex/config.toml` can include:

```toml
sandbox_mode = "workspace-write"

[windows]
sandbox = "unelevated"

[sandbox_workspace_write]
network_access = true
```

Merge these sections into existing configuration; preserve the model provider,
login and any intentional read-only policy. Elevated is the preferred native
implementation when its administrator-approved setup is available; unelevated
is a supported fallback. See the [official Windows sandbox documentation](https://developers.openai.com/codex/windows/).
The bridge's unattended CLI uses `approval_policy="never"`, so an interactive
elevation request cannot repair missing initial permissions. Network permission
does not expand the filesystem write boundary. Diagnose any later cache or
configuration write denial before adding a narrowly scoped writable directory.

## 1. Install the prerequisites

Install Windows 10/11, Node.js `22.13.0` or newer, the official Lark CLI, and
the Codex CLI. Sign in to the Lark and Codex accounts you intend to use. The
Lark CLI and Codex CLI are separate tools; this repository does not bundle or
authenticate either account for you.

Open PowerShell and confirm Node is available, then clone and install this
repository:

```powershell
git clone https://github.com/tototototoby/feishu-codex-bridge.git
Set-Location .\feishu-codex-bridge
node --version
npm ci
```

The app and runtime scripts default to command names on `PATH`. If your Node,
Lark CLI, or Codex CLI executable cannot be resolved, set its absolute path in
the private config `tools` object with the key `node`, `larkCli`, or `codex`.

## 2. Create private storage and app config

Choose the private data root before running `init`. The default is
`%USERPROFILE%\.feishu-codex-bridge`. To use `D:\FeishuCodexData` for the
current PowerShell session:

```powershell
$env:FEISHU_CODEX_HOME = 'D:\FeishuCodexData'
node .\src\cli.mjs init
```

`init` creates a config file and private runtime directories outside the
checkout. It refuses a data root inside the public repository. It prints the
config path; with the example path above, edit
`D:\FeishuCodexData\config.json`.

Add one entry under `assistants` in that private config. Use your own values;
the following values are placeholders only:

```json
{
  "schemaVersion": 1,
  "tools": {},
  "assistants": {
    "assistant-1": {
      "directory": "assistant-1",
      "profile": "assistant-1",
      "displayName": "My assistant",
      "appId": "cli_REPLACE_WITH_YOUR_APP_ID",
      "intendedUserEmail": "owner@example.invalid",
      "expectedTenantKey": "REPLACE_WITH_YOUR_TENANT_KEY",
      "model": "gpt-6.1-sol",
      "reasoningEffort": "high"
    }
  },
  "desktop": { "enabled": false, "chatId": "", "threadId": "", "relayCommentary": false },
  "group": { "enabled": false, "chatId": "", "ownerOpenId": "", "name": "", "recordHistory": false }
}
```

The key, directory, and profile names may contain letters, numbers, `-`, and
`_`. Pick a model and reasoning effort available to your own Codex account.
`messageReply` accepts `card`, `markdown`, or `text`. New office profiles
default to the interactive `card` presentation when no prior reply format is
configured. An explicit assistant-level `messageReply` overrides the upstream
profile preference; existing profile choices are otherwise preserved.

From v0.1.2, the Codex/card office path opens one regular progress card when
the authorized run starts. It refreshes truthful elapsed time every 10 seconds
while waiting and applies public message/tool-status events to that same card.
The final answer or terminal status replaces the same card; reasoning and raw
tool commands/outputs are excluded from the progress view. The CLI emits
whole message and tool events, so this is event-level progress rather than
character-by-character generation.

If the progress card cannot be created or its final update is unconfirmed,
the adapter attempts one independent plain-text final reply. Its separate
metadata ledger is written before sending; ambiguous sends are not retried.
An ambiguous final card update can therefore leave the answer visible in both
the card and the one text reply. If the ledger cannot be written, delivery is
blocked and recorded in metadata logs. This presentation change does not
guarantee delivery when the local disk or Feishu API is unavailable.

Assistant-level `notifyCompletion` defaults to true and may be set to false
to disable the separate terminal notice. Notice state contains only bounded
run identifiers and sending receipts in private bridge storage; uncertain
sends are not automatically repeated. Display updates do not add another
model execution, change the assistant's Codex home, or enable incoming-message
steering. Incoming work retains the configured upstream queue behavior.
Do not add the app secret, access tokens, or personal chat identifiers to this
file in the source checkout; this is the private copy under the data root.

The default owner identity method is `oauth-enterprise-email`. The
`enterprise_email` value can be empty even when the employee scope has been
granted; do not assume that granting more scopes will populate it. If it is
known to be empty for your app, choose `oauth-union-id` before creating the
assistant profile and add `expectedUserUnionId` to this private assistant
entry.

Establish that union-ID baseline independently of the OAuth candidate: look up
the exact intended email in the authoritative directory, confirm it returns
one employee, read back that employee's contact record, then record the
nonempty union ID and verify that the tenant and app share the same
application developer/ISV union namespace. A matching tenant alone does not
prove the union-ID namespace. Never use the candidate response as its own
expected baseline. If verification reports a missing email or identity
mismatch, keep the assistant disabled and resolve the identity baseline
before continuing.

## 3. Create the disabled assistant profile

Create the profile from the private config:

```powershell
node .\src\cli.mjs assistant init assistant-1
```

The resulting `assistant.json` is under
`<data-root>\assistants\assistant-1\assistant.json`. It starts disabled,
unverified, and blocked from group messages. Do not manually fill verification
results such as the allowed Open ID; the verification command writes those
fields only after a successful identity check.

## 4. Set up the bot credential and model account

Open the local credential entry helper for the bot app:

```powershell
node .\src\cli.mjs office setup assistant-1
```

Enter the app secret in the helper window. The helper validates the app
credential and saves it encrypted in that assistant's separate upstream
profile. The bot does not start during this step. Do not paste the secret into
PowerShell arguments, JSON, a screenshot, or an issue.

Log in to the Codex model service inside this assistant's own Codex home:

```powershell
node .\src\cli.mjs office login-model assistant-1
```

Complete the normal device sign-in using the account that should provide this
assistant's model service. This creates per-assistant CLI authentication; it
does not configure Feishu identity or authorize the bot to act as a user.

## 5. Explicitly approve owner identity setup

The setup verification temporarily reads the authorized Feishu user's own
identity so it can compare that person with the intended owner. Before
authorizing that check, open the private
`<data-root>\assistants\assistant-1\assistant.json` and change:

```json
"userAuthSetupApproved": false
```

to:

```json
"userAuthSetupApproved": true
```

This local approval authorizes only the minimal owner-identity check described
in [the permissions checklist](permissions.md). It does not authorize
message handling as the user. Runtime is kept bot-only, and the verifier
restores bot-only mode after checking the identity. If you do not approve this
check, leave the field `false` and do not run the following authorization
commands.

Run the profile-local authorization setup, sign in as the intended owner, and
verify the identity:

```powershell
node .\src\cli.mjs office-auth prepare assistant-1
node .\src\cli.mjs office-auth login assistant-1
node .\src\cli.mjs office-auth verify assistant-1
```

`prepare` binds the app in this assistant's private Lark CLI profile and keeps
incoming service disabled. `login` opens the interactive, profile-local user
authorization flow in the terminal; complete the QR code or URL flow in that
terminal as the intended owner. Keep the profile disabled and leave
`userAuthSetupApproved` set to `true` for this explicit setup step. Grant only
`contact:user.employee:readonly` for the identity check. The login is bound to
this profile; it does not import a global user session. Its profile-local
authentication state may remain on disk and must be treated as sensitive. It
is for setup identity verification only, not runtime permission to act as that
user. The command restores strict bot-only/default-bot policy before returning.

`verify` checks the user identity and tenant against the independent values in
your private config. On success it writes the verified binding but leaves
`enabled` set to `false`. On mismatch, the service must remain disabled; do not
manually edit the verification-result fields to bypass the check. The setup
flow keeps the assistant bot-only after the identity check.

If `verify` reports `enterprise-email-missing`, do not request broader scopes
or enable the assistant. After independently establishing the union-ID
baseline as described above, set `identityVerificationMethod` to
`oauth-union-id` and set `expectedUserUnionId` from that baseline in both the
private project `config.json` assistant entry and the matching private
`assistant.json`. Leave all `verified*`, `allowedOpenId`, and `enabled` values
unchanged. Then run `office-auth login` and `office-auth verify` again. If
verification still fails, leave the profile disabled and resolve the identity
source with an administrator; do not copy values from the failed candidate
response into verified fields.

The Feishu app must have the scopes, `im.message.receive_v1` long-connection
subscription, bot capability, and published visibility described in
[permissions.md](permissions.md). `offline_access` is not needed for bot
runtime and should not be granted for this release.

## 6. Review and start the assistant

After successful identity verification, manually review the private profile's
verified app, tenant, email/identity method, and bot policy. Then change only
the profile's `enabled` field to `true`. Do not change the verified identity or
allowed-user fields. Check readiness, register the disabled current-user logon
task, and start:

```powershell
node .\src\cli.mjs office check-ready assistant-1
node .\src\cli.mjs office task-install assistant-1
node .\src\cli.mjs office start assistant-1
node .\src\cli.mjs office status assistant-1
```

`task-install` registers the task in a disabled state and does not start the
assistant. `office start` enables and starts it. The task is limited to the
current Windows user and uses an interactive logon trigger. Review the task
and profile status after starting; this does not make the assistant a separate
Windows security principal or guarantee continuous service. To disable and
stop it:

```powershell
node .\src\cli.mjs office stop assistant-1
```

Use `doctor` for local prerequisite/configuration inspection at any point. It
does not test model access, app approval, or message delivery. A fresh
installation and live Feishu/Codex exchange remain unverified for this release.

## 7. Optional Desktop integration

Desktop routing is separate from the office bot setup. It needs an already
installed Codex Desktop/App Tools component and explicit configuration; it is
off in the example. See [Desktop experimental setup](desktop-experimental.md)
and [the security model](security-model.md) before enabling it.

The optional per-assistant visibility mirror is a separate advanced feature.
It requires `assistants.<key>.visibility` to name a local thread plus a
separate trusted `desktop-control.json` anchor. It is not a one-click or
automatic import of the Desktop sidebar. Each mirrored office record is an
actual prompt; leave the feature off unless you have verified the target
thread and reviewed its data flow.
