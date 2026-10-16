# Experimental Codex Desktop adapter

The Desktop adapter is an optional, version-sensitive integration. It uses the
user's separately installed Codex Desktop and App Tools component. This
repository does **not** bundle the Desktop helper, plugin, or other Codex
Desktop binaries, and it does not claim a stable public API for that local
component.

## Prepare and start

1. Install and authenticate Codex Desktop on the same Windows account that
   will run this project.
2. From the project directory, prepare the pinned adapter and create a
   dedicated Feishu/Lark bridge profile. Choose an absolute local workspace
   path and use the app ID from your own bot application:

   ```powershell
   node .\src\cli.mjs desktop prepare
   $workspace = Join-Path $env:USERPROFILE 'FeishuCodexDesktopWorkspace'
   node .\src\cli.mjs desktop profile create --agent codex --workspace $workspace --app-id 'cli_REPLACE_WITH_YOUR_APP_ID' desktop
   ```

The profile command prompts for the app secret interactively. Do not pass it
with `--app-secret` or place it in a command line, config file, or issue. The
profile and its credential live in the dedicated private store under
`<data-root>\desktop\bridge`; this is separate from the office assistant
profiles and the user's global Lark CLI config. The sample config sets
`desktop.profile` to `desktop`, matching the final profile argument above. If
you choose another profile name, set `desktop.profile` to the same value in
the private project config.

3. In the private project `config.json`, set `desktop.chatId` and
   `desktop.threadId` to the intended destination and explicitly set
   `desktop.enabled` to `true`. Keep `desktop.relayCommentary` set to `false`
   unless you have reviewed and intentionally enabled that optional forwarding
   behavior.
4. Start the adapter in the foreground:

   ```powershell
   node .\src\cli.mjs desktop start
   ```

`desktop prepare` validates the pinned upstream adapter and generates a local
copy under the private data root. `desktop profile` manages upstream profiles
inside the dedicated private bridge store. `desktop start` runs the generated
adapter with that store's private config and profile; it does not use the
office profile or the global Lark CLI profile. Arguments after `desktop start`
are passed as upstream `run` options. Config overrides and command-line app
secrets are rejected. It does not install or configure the separate Codex
Desktop application.

Use `doctor` to inspect local prerequisites. A successful check does not prove
that the desktop component is compatible or that a message will be delivered.

## Recovery after Desktop updates

After updating this project's source, run `node .\src\cli.mjs desktop prepare`
again and restart the Desktop adapter. Preparation updates its generated private
runtime; it does not recreate the bot profile or its credentials.

On Windows, a missing Codex executable previously discovered under
`%LOCALAPPDATA%\OpenAI\Codex\bin\<version>\codex.exe` can be resolved again
from that installation's direct version directories. Recovery requires one
valid executable, stays inside the installation's real directory, and rejects
linked candidate directories or files. Existing executables and explicit
`tools.codex` choices are preserved. No profile or credential is rewritten.
If no unique executable can be established, inspect the installation and
configure the intended tool/profile path explicitly; recovery fails instead
of guessing which version to execute. This applies to the Desktop adapter;
Office assistants retain their separate verified executable bindings.

If an App Tools update removes a saved `server.mjs`, the Desktop adapter can
resolve a replacement only when that missing path names a stable version under
the user's `.codex` cache or an absolute `CODEX_HOME` cache. It chooses the
highest available stable version in the same cache, compares version numbers
numerically, and rejects linked candidate version directories or scripts and
paths that escape the cache's real directory. Missing custom script paths still
fail. Resolution runs again before starting the MCP subprocess, so an update
between client creation and connection is also covered. Saved chat bindings and
credentials are preserved; endpoint ownership and exact thread checks remain
required.

When its saved App Tools endpoint disappears, discovery can order a valid
`CODEX_APP_TOOLS_PIPE_PATH` hint from the process environment within the same
pipe namespace. The pipe must still be enumerated and pass the existing
process-owner and anchor-thread checks. An existing preferred endpoint retains
the six-candidate fast path. If it is absent or fails its anchor check, recovery
within its saved namespace examines the complete candidate set, up to 32
pipes. Every ownership record must be present and unique, every candidate must
be verified, and all candidates must belong to one trusted Desktop process.
The exact local Codex thread ID is then checked with `read_thread`, using at
most eight concurrent probes within the existing 20-second deadline and
shutdown reserve. An environment hint only affects candidate ordering.

An oversized, unverifiable, ambiguous or slow candidate set remains blocked.
Without a saved namespace, the existing cross-namespace unique-endpoint
discovery policy still applies. This is bounded recovery for the supported
Desktop component, not a stable public transport contract.

## Data and limits

### Optional group member images

Group member image generation/editing is disabled by default. After the group
owner explicitly approves it, set `memberImagesEnabled: true` in the private
group control configuration (or private project `group` settings). The existing
group must already be enabled and bound to its intended bot app, owner and
workspace; member participation also requires `respondToOwnerOnly: false`.
The image gate accepts only the control loaded with the running bot's matching
app binding. A real user must actually mention that bot in the configured group;
quoted mention text, group history and slash commands cannot grant capabilities.

Members still use ephemeral Codex runs, a read-only sandbox, no session resume,
ignored local rules and disabled shell/code execution, apps, plugins, MCP,
browser, private history and administrative tools. Only native image generation
is enabled for this opt-in path. The image profile enables the required local
registered-tool host while general code mode remains disabled. The child receives
a bounded environment
allowlist for OS/runtime, provider and transport settings, without Feishu or
Desktop App Tools credentials. This option does not grant group management or
general external write permissions.

The host reads back the triggering message and verifies the sender, group and
actual mention. Accepted image references come from that message or verified
images in this group's supplied recorder context. It stages them into a unique
`input/<request-id>` directory and passes them as image inputs; arbitrary files
and other groups' references are excluded. A manifest tracks input hashes and
generated artifacts under this group's workspace.

Completed native image events with a real `saved_path` register output first.
Some CLI versions omit those events from `exec --json`; after a successful,
uninterrupted run, compatibility collection uses only that ephemeral run's raw
`thread.started` UUID to inspect the first level of its own
`generated_images/<thread-id>` directory for `exec-<UUID>` images. Conflicting
thread IDs block this path. It never searches the whole cache, selects the latest
file or reads an image path from final prose. Collection considers at most 64
matching candidates, with a shared limit of 8 images / 128 MiB total and 64 MiB
per image across both event and compatibility paths.

The host checks native image roots, symlinks, creation time, byte limits, image
signatures and content hashes, then copies validated output into
`output/<request-id>`. Final prose cannot nominate a path for upload. Return uses
the existing group media outbox and the original triggering message; stopped,
failed or timed-out runs do not enter the image return branch. Uncertain sends
retain the existing no-automatic-duplicate behavior.

Run `desktop prepare` and restart after updating the source so the generated
adapter includes the integration. Native event formats and tool availability
depend on the installed Codex version and provider. Static source review does
not prove image generation or delivery: verify a real authorized request and
its returned image separately. If no validated artifact is produced, the bridge
reports that the image task remains incomplete.

Historical thread pagination uses a 20,000-character per-item read limit to
match the Codex Desktop App Tools API limit.

### Completion notifications (v0.1.1)

Set `desktop.notifyCompletion` to `true` in your private project config to
receive a separate short text message after a linked direct-chat request has
its final card confirmed and its final-media handler completed. The message
includes a documented link to open the same chat. This creates a new chat
message rather than only editing the existing card; notification banners and
sounds still follow your Feishu and operating-system notification settings.

The option is explicit in the new example config and disabled when absent.
It applies to newly accepted direct-chat requests; it does not notify groups
or replay old completed requests. Sending intent and receipts are persisted.
An ambiguous send result is marked uncertain and is not automatically sent
again. This avoids duplicate reminders at the cost of a possible missed
reminder if the network outcome is unknown. A notice failure does not rerun
the model or replace its successful final answer.

Large-image resizing is optional and requires an installed `sharp` module.
Install it locally without changing the release lockfile with
`npm install --no-save --package-lock=false sharp`, or set `tools.sharp` to the
absolute path of an existing module entry. Text routing and ordinary file
handling do not require this optional image-resizing dependency.

The adapter targets the chat and thread IDs in the private project config.
Keep those identifiers and any local adapter state out of source control.
Enabling the integration can send Feishu message content to the configured
Codex Desktop thread. Optional commentary forwarding is off in the sample
config; review the destination and content before opting in.

Feishu office-record mirroring is prompt-based: each mirrored record is sent
to the configured thread as an instruction to display it. It is not a
read-only transcript or a UI-only copy, and the prompt wording cannot guarantee
that the assistant will take no action.

The external App Tools component and its local communication path can change
between desktop releases. The adapter may require a compatible installed
version and may need an update after a Desktop or App Tools change. There is no
compatibility matrix, uptime commitment, exactly-once delivery promise, or
long-term support guarantee for this experimental integration.
