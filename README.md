# PiDeck

[English](./README.md) | [简体中文](./README.zh-CN.md)

PiDeck is a desktop interface for [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It turns Pi's SDK into a visual workspace for conversations, tool calls, sessions, models, and Packages.

> **P0 source gate: passing.** `pnpm verify:p0` has passed on Apple Silicon macOS and is the tracked GitHub Actions gate on Windows. It covers documentation, type checks, unit and Host integration tests, the production frontend build, and Rust tests.

PiDeck supports early testing from source on Windows and macOS. Distribution is a separate milestone: the release pipeline produces Windows x64, Apple Silicon macOS, and Intel macOS development candidates, but public-release code signing is still required.

## What is included

- Streaming chat with thinking, tool calls, results, abort, and recovery.
- Workspace and Session browsing, creation, reopening, and restoration.
- Provider, model, thinking-level, and usage controls.
- Package management for Extensions, Skills, Prompts, and Themes.
- Extension UI support and an integrated workspace shell terminal.
- Shared Pi data compatibility through `~/.pi/agent` and project `.pi` directories.

PiDeck currently pins the Pi SDK to `0.82.1`.

## Platform status

| Platform | Source development | Packaging |
|---|---:|---:|
| Windows 11 x64 | Supported; tracked CI gate | Unsigned NSIS development candidate |
| macOS Apple Silicon / Intel | Supported for early testing | DMG development candidate |

Both platforms can run the full application with `tauri:dev` and build a native candidate with `package:release`. The optimized `dev:fast` workflow remains Windows-only. Revealing a local path uses the native file manager on each platform (Explorer `/select`, Finder `open -R`).

## Quick start

### Requirements

- Node.js — the version pinned in [`.node-version`](./.node-version), which development and CI both use. **22.19.0** is the minimum supported runtime.
- pnpm **9.15.0**
- Rust stable
- [Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/)

Use the pinned pnpm version. pnpm 11 ignores the `patchedDependencies` location used by this repository and can install an incorrect Pi SDK tree.

For macOS desktop development, Xcode Command Line Tools are sufficient:

```bash
xcode-select --install
```

For Windows desktop development, install:

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with **Desktop development with C++** selected.
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). It is already present on most Windows 11 installations.
- [Rustup](https://rustup.rs/) with the stable toolchain.

In PowerShell, `fnm` plus Corepack can provide the pinned Node and pnpm versions. Run this from the repository root so `.node-version` resolves:

```powershell
winget install Schniz.fnm
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
fnm install (Get-Content .node-version)
fnm use (Get-Content .node-version)

npm install --global corepack@latest
corepack enable pnpm
corepack prepare pnpm@9.15.0 --activate
```

To load `fnm` automatically in future PowerShell sessions, add the `fnm env` line to `$PROFILE`.

One way to install the expected Node and pnpm versions on macOS is, again from the repository root:

```bash
brew install fnm
eval "$(fnm env --use-on-cd --shell zsh)"
fnm install "$(cat .node-version)"
fnm use "$(cat .node-version)"

npm install --global corepack@latest
corepack enable pnpm
corepack prepare pnpm@9.15.0 --activate
```

### Install and launch

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @pideck/desktop run tauri:dev
```

The first launch compiles the Tauri application and may take several minutes. Subsequent launches reuse the Rust build cache.

## Pi CLI is not required

PiDeck uses `@earendil-works/pi-coding-agent` directly as an application dependency. It does not invoke a globally installed `pi` executable, so PiDeck works even when the Pi CLI is not installed.

PiDeck uses `~/.pi/agent` by default. If you install the Pi CLI later and keep its default data directory, the CLI and PiDeck can share:

- Sessions and conversation history
- Authentication and model settings
- Packages, Extensions, Skills, Prompts, and Themes

Project resources live under each workspace's `.pi` directory and are shared when both applications open the same workspace.

For the best compatibility, keep the CLI version close to PiDeck's pinned SDK version. A much newer CLI may write settings or Session entries that SDK `0.82.1` does not understand. Avoid modifying the same Session concurrently from the CLI and PiDeck.

## Verify a checkout

```bash
# Documentation, type checks, and all JavaScript/TypeScript tests
pnpm verify:quick

# Full P0 source gate: quick checks, production build, and Rust tests
pnpm verify:p0
```

If the first Rust dependency download fails because crates.io is too slow, retry with:

```bash
CARGO_HTTP_TIMEOUT=600 CARGO_HTTP_LOW_SPEED_LIMIT=1 CARGO_NET_RETRY=10 pnpm test:rust
```

## Security

Selecting a workspace immediately authorizes and loads its project resources. Code in `.pi/extensions` can execute locally with your user permissions. Only open workspaces and install Packages you trust.

Provider credentials, settings, Packages, and Sessions are user data. Do not commit files from `~/.pi/agent` into this repository.

## Current release boundary

The passing P0 source gate demonstrates that the implemented core behavior builds and passes its automated checks. It does not by itself certify a downloadable installer.

Before a public release, the project still needs accepted packaging evidence and platform code signing. Native development candidates are built with:

```bash
pnpm package:release
```

On Windows this produces an NSIS installer. On macOS it produces a DMG plus the signed Tauri updater archive. Without Apple Developer secrets, the macOS candidate is ad-hoc signed and may require manual approval in Privacy & Security; it is not a certified public release. See [P0 scope and verification](./docs/operations/p0-scope.md) for the exact source and release boundaries.

## Workspace layout

| Path | Role |
|---|---|
| `apps/desktop` | React/Vite interface and Tauri 2 desktop host |
| `packages/protocol` | Typed Rust/Host/UI process protocol |
| `packages/pi-host` | Node sidecar and Pi SDK owner |
| `docs` | Architecture, development, and release documentation |
| `test-fixtures` | Test Packages and Extensions |
| `scripts` | Verification, runtime staging, and packaging tools |

## Documentation

- [Documentation index](./docs/README.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Development guide](./docs/operations/development.md)
- [P0 scope and verification](./docs/operations/p0-scope.md)
- [Release notes and limitations](./docs/operations/release.md)

## License

MIT — see [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
