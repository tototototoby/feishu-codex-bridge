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

## Data and limits

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
