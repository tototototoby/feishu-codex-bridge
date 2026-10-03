# Contributing

Thanks for helping make this source extraction safer and easier to use.

## Before opening an issue or pull request

- Describe the Windows version, Node.js version, project version, and the
  affected command. Redact logs and remove app IDs, open IDs, union IDs,
  tenant identifiers, email addresses, message text, tokens, and local paths
  that identify a person or machine.
- Keep changes focused. Update `README.md` and `README.en.md` together when a
  user-facing command, requirement, or limitation changes.
- Keep all credentials and runtime state outside the checkout. Do not commit
  private `config.json`, assistant profiles, App Tools thread identifiers,
  databases, histories, workspaces, logs, screenshots, or authentication
  material.

## Implementation guidance

- Preserve fail-closed identity and bot-only runtime behavior. New permissions
  must be narrowly scoped, justified, and documented in
  [`docs/permissions.md`](docs/permissions.md).
- Keep group history, Desktop routing, and commentary forwarding opt-in. Explain
  what content is sent to which service whenever a new data path is introduced.
- Assistant folders run under the same Windows user and are not OS-level
  sandboxes. Do not describe them as isolated security principals.
- Do not promise exactly-once execution, guaranteed delivery, or long-term
  compatibility. Keep the Desktop integration version-sensitive and do not
  bundle the separately installed Desktop helper or plugin.
- Preserve upstream notices when changing code derived from
  `lark-channel-bridge`. When adding or changing dependencies, update the SPDX
  inventory and copy the actual license/notice files available from the
  resolved package tree. Do not infer a license when package metadata is
  absent; record the uncertainty and retain the upstream license text.

## Validation notes

This repository does not make a behavioral test-suite or CI guarantee in
v0.1.0. In a pull request, list the commands and manual checks that actually
ran, the environment used, and what remains unverified. Do not report a
successful live Feishu/Codex flow unless it was exercised with an account and
tenant you control.

## Pull request content

Keep the change and its documentation reviewable. Include a short summary,
changed files, validation evidence, known limitations, and any permission or
data-flow changes. Use synthetic examples only; do not attach private runtime
artifacts to the PR.
