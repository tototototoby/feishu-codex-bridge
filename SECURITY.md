# Security policy

## Reporting a vulnerability

Please do not post credentials, tokens, private chat content, personal
identifiers, or an unpatched vulnerability in a public issue.

Use GitHub's private vulnerability reporting for
[this repository](https://github.com/tototototoby/feishu-codex-bridge/security/advisories/new)
when it is available. If private reporting is disabled, contact the repository
maintainer through the GitHub profile and ask for a private disclosure route.
Include the affected version, a concise impact description, and steps to
reproduce that do not expose real user data.

There is no published response-time commitment. Until an issue is resolved,
share only the details needed to coordinate a fix and avoid public disclosure
of exploit steps.

## Supported release status

`v0.1.0` is an initial experimental, Windows-first source extraction. A fresh
installation has not been verified end to end. The Codex Desktop adapter is
experimental and depends on a separately installed, version-sensitive App
Tools component. Do not send production or sensitive conversations through it
without reviewing the data flow and independently validating the setup.

For operational boundaries, local data locations, and identity handling, see
[`docs/security-model.md`](docs/security-model.md).
