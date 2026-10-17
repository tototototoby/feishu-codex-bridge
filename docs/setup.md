# Windows setup guide

This guide describes the intended `v0.1.2` setup flow. A clean-install,
end-to-end run has not been verified. Use a Feishu/Lark tenant and Codex
account that you control, and start with a test bot and non-sensitive messages.

## Office recovery after updates and reboots

Updating Codex Desktop can remove the version directory recorded in an Office
profile. Office runtime v4 checks the executable at adapter construction,
availability checks and process launch, so an already running supervisor can
also handle a later installation update. The assistant/profile executable
binding and identity checks remain in effect; recovery only changes the
in-memory executable used for that invocation.

Recovery is limited to a missing Windows path of the form
`%LOCALAPPDATA%\OpenAI\Codex\bin\<16-hex-version>\codex.exe`, with no explicit
`tools.codex` configuration. The installation tree and candidate must be real
directories/files without linked or reparse paths, and exactly one valid
candidate must exist. Other configured paths, permission errors and ambiguous
installations remain blocked. Inspect explicit tool/profile bindings when
manual repair is needed; do not select a version just by its modification time.

After updating this source, use the normal per-assistant `office stop <key>`
and `office start <key>` lifecycle. A stopped assistant's generated CLI can
upgrade from v1, v2, v3, v4, v5 or v6 to v7 only when its bytes match the corresponding content
rebuilt from the pinned upstream package at the current installation location.
A v7 copy is reused only when it matches the expected content. Unknown/manual changes
are rejected rather than overwritten; moving the installation or dependencies
can likewise require review of the private generated copy. Private profiles,
credentials and workspaces are not recreated during this upgrade.

Executable discovery and OS process launch are separate operations; an
installation update between them can still make that particular launch fail.
A successful startup is also insufficient evidence of Feishu delivery. Check
the actual reply receipt and content for a real authorized incoming request.
Messages missed while the service was down are not automatically replayed;
the existing recovery inbox requires validated original message IDs and
shares the durable intake claim ledger.

## Office startup retry and manual recovery

Office runtime v3 and later can retry one startup failure for the same run and original
source messages. It observes every raw Codex stdout line before translation and
requires only the exact startup sequence ending in
`workspace routing discovery timed out`, with no assistant output, tool calls,
unknown records or extra fields. The first process must close naturally with a
nonzero exit code and no signal, interruption or runtime error before retry.
Output buffers are bounded. A process that remains open eight seconds after a
terminal record or exit is cleaned up and disqualified from retry.

Retry claims are stored under the assistant's private bridge directory, once
per run and per original message ID. Existing, partial or uncertain claims
block another retry even across a restart or overlapping message batches. The
original intake ledger is preserved; retry does not enqueue the message again.
Capacity errors, authorization failures and failures after work has started
still require review. A successful retry is not proof that future requests or
their Feishu delivery will succeed.

Manual recovery of an already claimed message requires a reviewed recovery
inbox entry and a matching one-attempt grant in that original ledger entry.
The inbox reads back the exact Feishu message, chat and user sender before
creating an in-memory grant for the normalized source object. The intake path
consumes that grant once and records `recovery_claimed`; live duplicate events
cannot use it. Do not clear original claims to force recovery, and do not grant
recovery where prior output, side effects or delivery remain uncertain.

Recovery supports text and rich-text `post` messages through the same upstream
normalizer as live messages, preserving post resource references for ordinary
attachment handling. Other message types remain marked for manual recovery.
Completion notices require a successfully completed streamed reply. An idle
visibility mirror, an accepted request or a progress card does not prove that
the business request completed. Visibility records are deferred while the
configured local Codex target has an active turn; an unloaded target additionally
requires explicit local identity, Codex kind and turn evidence.

## Optional live input for Office CLI runs

Live input is disabled by default. After reviewing the intended assistant, set
`"liveInputEnabled": true` in its private `assistant.json`, then use the normal
per-assistant stop/start lifecycle after updating source. The field accepts only
a boolean; its existing identity, path, app, owner and profile checks still apply.
Keep private profiles, state, claims and credentials outside source control.

The live route starts a dedicated Codex stdio app-server for the CLI run, retaining
that assistant's configured Codex home, Lark identity and existing thread binding.
New input targets the current thread and active turn through `turn/steer`.
The host does not create a visibility mirror or a second writer to inject input.
The existing authorization preflight remains outside the live run; when live
input is disabled, the existing CLI and constrained startup retry route remains.
The separate native Desktop integration below retains its own transport.

Before spawning, the adapter acquires a durable exclusive writer lease in the
canonical real `CODEX_HOME`. An existing lease blocks another writer, including
across bridge restarts. The normal final/done result is emitted only after the
child closes and ownership is verified while releasing the lease. Unconfirmed
shutdown or release failure leaves the home blocked. Recovery requires a
maintainer to establish that the original writer has exited and review the saved
ownership evidence; neither PID/age guesses, changing timestamps nor deleting a
claim to retry is a supported recovery procedure.

Only the verified owner's direct messages in the current scope can steer the
run. Group/topic messages, bot senders and unrelated scopes are ineligible.
Existing intake claim, access and command gates run first. Accepted attachments
and quoted context use the existing intake policy. An OAuth confirmation for a
pending private device flow stays on the original pending/preflight path, so
steering cannot bypass its source, time and nonce checks.

Before submitting, the host writes a permanent exclusive source claim and a
bounded state record under the assistant's private bridge home. A confirmed
`not-active` response may defer to the pending queue once; timeouts, exceptions,
ambiguous acceptance and persistence failures are consumed without automatic
replay. Unresolved state and stale locks require reviewed recovery, never age-based
deletion or clearing claims to force another submission. A steer acknowledgement
means acceptance only, not completion of the new request or Feishu delivery.

This protocol is version-sensitive. Static source review is not an end-to-end
acceptance run; support for the installed app-server, steering, stop handling,
model output and actual replies must be verified using a real authorized request.
No fresh live CLI roundtrip is claimed by this source publication.

## Optional native Codex Desktop execution

Office runtime v4 can send new requests directly into one existing native
Codex Desktop thread. Enable this only after the owner explicitly authorizes
using that thread's current tools, skills, resources and model authorization.
Execution uses the shared Desktop runtime; the retained CLI profile and Codex
home are transport and history metadata in this mode. The verified bot app,
owner open ID and direct-message chat remain fixed delivery boundaries.

Copy [the disabled native example](../examples/office-native.example.json) to
`<assistant-directory>/native-desktop.json`, and fill it locally using verified
values. `appId`, `allowedOpenId` and `workspace` must match the existing office
assistant. `chatId` identifies its owner's direct message. `threadId` is the
intended native Desktop thread; `anchorThreadId` is a distinct trusted local
thread used to verify the App Tools endpoint. `controlPath` must be the absolute
path `<assistant-bridge-home>/native-desktop-control.json`. Use
[the control example](../examples/office-native-control.example.json) for that
file and set its matching `threadId` and current trusted local `pipePath`.
The portable runtime resolves the installed App Tools server and Node through
the usual project tools settings. Private bindings and pipe identifiers belong
in the data directory, never in source control.

Set `enabled: true` only after reviewing both files and the recipient mapping,
then use the normal `office stop <key>` / `office start <key>` lifecycle.
Absent or explicitly disabled native configuration keeps the CLI route.
Invalid enabled configuration consumes the request without starting a second
executor or visibility mirror. Availability notices require readback of the
original sender, chat and message, and persist a sending intent before sending;
uncertain intents are not automatically repeated. Local readiness confirms
binding and state only, not actual endpoint or business-message delivery.

`/stop` steers the current native thread to stop unfinished work; it does not
guarantee forced interruption. `/status` asks that thread for its actual state.
Session-changing commands such as `/new`, `/reset`, `/resume`, `/cd`, `/ws`
and `/timeout` return a fixed-connection explanation. Activation does not
replay old business requests. Incoming attachments and quoted messages follow
the normal media/reference handling, with missing items reported explicitly.

Requested outgoing deliverables must be explicit Markdown links to absolute
Windows paths between `<!-- office-output:start -->` and
`<!-- office-output:end -->` in the marked final answer. The bridge removes
that region from the visible answer and sends only supported files whose real
paths remain under `<assistant-workspace>/output`. Each file is limited to
26 MiB, with at most 16 output links per answer. Images, PDF, Office/ZIP/ODF,
RTF and common text files receive size, extension and content checks. The
source message, sender and bot binding are verified before delivery; changed
bytes, uncertain sends and restart-interrupted sends are not retried
automatically. A send receipt and successful readback are separate evidence.

This integration is experimental. Source publication and local readiness do
not prove live request, stop/status, incoming media or outgoing attachment
delivery. Verify only through authorized business messages and retain the
actual receipts before claiming completion.

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
message handling as the user. Runtime defaults to bot-only, and the verifier
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

### Optional owner-approved user CLI identity

Office runtime v5 supports a separate, explicit user CLI opt-in after the owner
has confirmed that the assistant may use their Feishu user permissions. In the
private `assistant.json`, the optional fields are:

```json
{
  "larkCliIdentityPreset": "user-default",
  "userAuthSetupApproved": true,
  "userCliApprovedOpenId": "<verified-allowedOpenId>"
}
```

Replace the placeholder locally with the assistant's already verified
`allowedOpenId`, only after that person's explicit approval. The assistant must
also be enabled and pass all existing identity and mapping checks; missing or
mismatched approval blocks `user-default`. Omit `larkCliIdentityPreset` or set it
to `bot-only` to retain the default. The profile policy, CLI identity application
and settings form all use this same descriptor choice. This does not change the
bot transport, owner allowlist or direct-message delivery binding.

These fields record approval; they do not perform OAuth or prove that a token
has the required scopes. Complete the intended owner's interactive authorization
inside this assistant's private CLI profile and separately verify its identity
and the scopes required by the authorized task. Office runtime never
automatically imports a local/global user credential. The owner-identity setup
commands above restore bot-only policy, so complete those checks before this
opt-in and use the normal `office stop <key>` / `office start <key>` lifecycle.
Keep approval identifiers, profile configuration and auth logs out of source control.

For an approved `user-default` CLI task, runtime v6 performs a host preflight
before starting the model: `auth status --json`, then the fixed read-only
`GET /open-apis/authen/v1/user_info --as user`, then `auth status --json` again.
It requires the verified app/owner binding and existing matching tenant/union-ID
baseline, compares all three user identity fields, and requires a valid token
after the API call. The host CLI can refresh its own protected credential during
that call; the bridge neither copies credentials nor changes them to plaintext.
Missing approval, identity mismatch, invalid status, timeout or uncertain process
closure blocks model launch. The default remains `bot-only`.

The host executable is fixed at
`%LOCALAPPDATA%\Programs\nodejs\node_modules\@larksuite\cli\bin\lark-cli.exe`;
model output, run options and `PATH` cannot select it. The commands use only this
assistant's private profile. Concurrent preflights share one bounded operation
per profile, and cancellation preserves the existing startup retry boundary.
This addresses the task launch boundary only: a long task can outlive its token
and still encounter a later sandbox credential-refresh failure. It does not
prove task completion, scope sufficiency or actual message delivery.

### Optional host completion of Minutes OAuth

An already approved `user-default` profile can save a pending interactive Minutes
authorization on the host before model launch. This optional path accepts exactly
the two scopes `minutes:minutes.basic:read` and `minutes:minutes.upload:write`;
it cannot begin a flow or add other scopes. A trusted local operator must create
the flow using the intended assistant's private CLI profile and store its pending
record at `<assistant-bridge-home>/.office-user-oauth.json`. The record binds the
app, owner, original chat, creation/expiry times, requested scopes and device nonce.
The private flow creator and any authorization-message sender are not distributed
in this repository. Keep the pending record, nonce, credentials and receipt logs
outside source control and out of model prompts.

Only source message IDs supplied by the existing host intake are considered.
The host reads those exact messages as the bot, then reads the matching raw
message to verify the owner, tenant, chat, unquoted text confirmation and precise
13-digit creation time. Confirmation must fall within this flow's time window;
quoted replies, prompt text and minute-formatted shortcut timestamps do not
authorize completion. The profile's existing app/owner identity policy still
applies.

Before exchanging the device nonce, the host creates a persistent exclusive
`wx` claim keyed by app, owner and nonce, and persists `completion-started`.
Changing the creation time cannot replay the same nonce. Claims are never
automatically deleted, including partial writes, crashes and failed exchanges.
The only OAuth mutation is completion of this existing device flow using the
fixed host CLI; the model cannot select the command or expand its scopes.

Completion requires exit code zero followed by the full status/user-info/status
postcondition: verified app/owner/tenant/union identity, valid token and both
requested scopes present in the stored profile. Success persists `completed`
and removes the device nonce from that record. Later preflights resume from the
completed state by verifying credentials and scopes again, without replaying the
exchange. Failure or uncertainty blocks automatic retry; an operator must inspect
the saved state and create a new flow with a new nonce when recovery is needed.
Do not delete a claim or edit timestamps to force another exchange.

The model-visible `work/office-user-auth-status.json` contains only status,
requested scopes, update time and an error category. A status-file publication
failure does not change a completed OAuth outcome. These are source-level
guarantees and recovery rules; publishing this code does not establish that a
real OAuth flow, protected credential save or Minutes operation has succeeded.

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
