# Third-party notices

The original Feishu Codex Bridge source in this repository is licensed under
the MIT License in [`LICENSE`](LICENSE). This file records the upstream source
and runtime packages observed for the v0.1.0 source snapshot. Full license
texts copied from the corresponding installed package files are in
[`licenses/`](licenses/), and the package-level inventory is recorded in
[`licenses/manifest.spdx.json`](licenses/manifest.spdx.json).

## Ported upstream source

This project includes a Windows-oriented source port derived from
`lark-channel-bridge` version `0.7.1`. Its package metadata identifies the
upstream project as
[feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge)
and its license as MIT. The upstream copyright and license text are preserved
in [`licenses/lark-channel-bridge-0.7.1.LICENSE.txt`](licenses/lark-channel-bridge-0.7.1.LICENSE.txt).

## Runtime packages

The project package manifest pins `lark-channel-bridge@0.7.1`,
`@larksuite/channel@0.6.1`, `cross-spawn@7.0.6`, and
`proper-lockfile@4.1.2`. The installed upstream package's direct runtime
dependencies were inspected at these versions:

| Package | Version | License metadata / notice | Copied text |
| --- | ---: | --- | --- |
| `@clack/prompts` | 1.8.1 | MIT | [`licenses/clack-prompts-1.8.1.LICENSE.txt`](licenses/clack-prompts-1.8.1.LICENSE.txt) |
| `@larksuite/channel` | 0.6.1 | MIT | [`licenses/larksuite-channel-0.6.1.LICENSE.txt`](licenses/larksuite-channel-0.6.1.LICENSE.txt) |
| `commander` | 12.1.0 | MIT | [`licenses/commander-12.1.0.LICENSE.txt`](licenses/commander-12.1.0.LICENSE.txt) |
| `cross-spawn` | 7.0.6 | MIT | [`licenses/cross-spawn-7.0.6.LICENSE.txt`](licenses/cross-spawn-7.0.6.LICENSE.txt) |
| `graceful-fs` | 4.2.11 | ISC | [`licenses/graceful-fs-4.2.11.LICENSE.txt`](licenses/graceful-fs-4.2.11.LICENSE.txt) |
| `proper-lockfile` | 4.1.2 | MIT | [`licenses/proper-lockfile-4.1.2.LICENSE.txt`](licenses/proper-lockfile-4.1.2.LICENSE.txt) |
| `qrcode-terminal` | 0.12.0 | The installed `package.json` has no `license` value. Its `LICENSE` file contains Apache License 2.0 text and a separate MIT notice for its vendored QRCode for JavaScript. | [`licenses/qrcode-terminal-0.12.0.LICENSE.txt`](licenses/qrcode-terminal-0.12.0.LICENSE.txt) |

The separately installed `@larksuite/cli@1.0.96` is an external command used
by the setup/runtime environment; it is not bundled by this repository. Its
observed package license is MIT, copied to
[`licenses/larksuite-cli-1.0.96.LICENSE.txt`](licenses/larksuite-cli-1.0.96.LICENSE.txt).
Its installed dependency tree also uses `@clack/prompts@1.8.1`, already listed
above.

The versions above are observations from the installed package manifests used
while preparing this source snapshot, not a claim that every later dependency
tree has the same versions. When package pins or the lockfile change, refresh
the inventory and copied license files from the resolved package tree before
redistributing. This inventory records the project package's direct runtime
dependencies, the upstream package's direct runtime dependencies, and the
separate Lark CLI command; it is not a complete inventory of every transitive
package in an installed `node_modules` tree.
