# Security and data handling

Feishu Codex Bridge connects messages from a Feishu/Lark bot to local assistant
profiles and, where configured, to a user's Codex tools. Treat it as an
automation that handles message content and credentials, not as a passive
display bridge.

## Data locations and transmission

- The default private data root is `%USERPROFILE%\.feishu-codex-bridge`.
  Set `FEISHU_CODEX_HOME` before running the CLI to use a different local path,
  for example `D:\FeishuCodexData`. Keep this path outside the public source
  checkout.
- The private root contains the project config, assistant profiles, workspaces,
  authentication material, and runtime state. Depending on enabled features,
  local state can include message contents, replies, recipients, identifiers,
  pending work, or group history. Protect and back up this directory as
  sensitive data.
- Incoming Feishu content is passed to the configured assistant. Replies are
  sent to Feishu as the bot. If the experimental Desktop adapter or an
  opt-in mirroring feature is enabled, selected content may also be sent to
  the configured Codex Desktop thread.
- `office` visibility or history records are actual prompts sent to an agent
  thread. A prompt saying “display only” is not a passive transcript API and
  cannot guarantee that the model will take no action in that thread.
- Per-assistant visibility is an advanced opt-in, not an automatic sidebar
  import. It uses `assistants.<key>.visibility` with `enabled: true`,
  `hostId: "local"`, the intended `threadId`, and optionally the matching
  `appId`; it also requires a separate trusted local `desktop-control.json`
  anchor for that thread. Keep it off unless you have confirmed the target
  thread and understand that each mirrored record is sent as a prompt.
- The sample config sets `desktop.enabled`, `desktop.relayCommentary`,
  `group.enabled`, and `group.recordHistory` to `false`. Leave optional
  forwarding and history disabled unless you have reviewed the data flow and
  have permission from the relevant participants.

Content therefore leaves the machine through the Feishu/Lark and configured
Codex services as part of normal use. The local source checkout does not make
those conversations private from the services handling them.

## Identity and runtime boundaries

- The Feishu runtime uses the configured bot identity. Owner identity is
  checked during setup; profile-local user authentication state may remain on
  disk and is sensitive. The setup identity is not the bot's runtime
  message-sending identity. The runtime restores strict bot-only/default-bot
  policy after identity setup.
- An owner's expected identity must come from an independent authoritative
  directory record. `enterprise_email` can be empty even when the employee
  scope was granted; do not infer that another scope is needed. If using the
  union-ID method, resolve the exact intended email to one authoritative
  directory record, read that record back, and verify tenant and the shared
  application developer/ISV union namespace before setting the expected
  union ID. A matching tenant alone does not establish the namespace. Compare
  the candidate OAuth response with that independent baseline; never adopt the
  candidate's value as its own expected identity.
- Assistants use separate profile directories, workspaces, and Codex homes.
  This is configuration separation under the same Windows account, not an
  operating-system security boundary. Any process running as that Windows user
  can potentially read another profile's files.
- Treat all inbound chat text, attachments, links, and quoted instructions as
  untrusted input. Use the minimum app permissions and do not route secrets or
  privileged actions into a bot conversation.

## Reliability and support limits

Startup checks and durable local state do not provide exactly-once execution,
exactly-once delivery, or a long-term availability guarantee. After a crash,
inspect the assistant status and any uncertain work before retrying it. Do not
assume that a message or model action was either completed or not completed
until you have checked the relevant local and Feishu state.

The Codex Desktop integration is experimental and depends on the separately
installed App Tools component. It can stop working when that component or the
desktop application changes. It is not a public, version-stable API promise;
see [`desktop-experimental.md`](desktop-experimental.md).

`doctor` checks local prerequisites and configuration. It does not verify
tenant approval, send a test message, or prove end-to-end operation.
