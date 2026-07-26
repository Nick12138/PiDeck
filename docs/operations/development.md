# Development

## Prerequisites

- Node.js `>= 22.19.0` minimum; development and CI use the exact version pinned
  in `.node-version` / `.nvmrc`
- pnpm `9.x`
- Rust stable + [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) (for desktop)
- Windows 11 x64 or Apple Silicon macOS for source development

Windows desktop development requires Microsoft C++ Build Tools with the
**Desktop development with C++** workload and WebView2. macOS desktop
development requires Xcode Command Line Tools (`xcode-select --install`).
The repository does not currently claim Linux support.

## Install

```bash
pnpm install --frozen-lockfile
```

Lockfile: `pnpm-lock.yaml` (committed). The Pi SDK pins are the exact
`@earendil-works/pi-*` production dependencies in `packages/pi-host/package.json`;
release scripts derive and validate the installed SDK family from that manifest.

## SDK patch (pnpm patch)

`patches/@earendil-works__pi-coding-agent@0.82.1.patch` gives
`DefaultPackageManager` a `setOperationSignal()` hook and passes that signal to
both child-process paths, so an aborted package operation actually kills the
npm or git child instead of leaving it running and holding the graph lock.
Upstream has no such hook. `setOperationSignal` is declared as a **required**
member of the `PackageManager` interface, which makes a silently skipped
`pm.setOperationSignal?.(...)` a compile error rather than a no-op.

The synchronous global-npm-root lookup cannot be interrupted — `spawnSync`
takes no signal — so the patch only makes it refuse to start a new child once
the operation is aborted. Every long-running operation (npm install, uninstall,
view; git clone, checkout, fetch, reset, clean) is on the cancellable async
path.

The 0.80.7 patch also preserved the SDK's extension module cache across cwd
changes and added a `preserveExtensionCache` reload option. Both are gone in
0.82.1: package reconcile now uses the official full reload, and every reload
re-imports extension modules. Re-evaluate the patch on every SDK upgrade;
consider proposing the cancellation hook upstream.

The patch deliberately stops at `DefaultPackageManager`.
`DefaultResourceLoader` builds its own private package manager that PiDeck
cannot reach, so a reload can neither be cancelled nor bounded. Rather than
patching a second class, PiDeck removes the reason to cancel: see
"Implicit resource loading" below.

## Implicit resource loading

`DefaultResourceLoader.reload()` resolves configured packages with no
`onMissing` handler, which makes the SDK install silently — a configured npm
package absent from disk (or whose installed version no longer satisfies its
range) triggers a real `npm install`, and an absent git package a real
`git clone`.

Workspace selection, the startup preload, and session create/open must all stay
offline, so they wrap the reload in `withoutImplicitPackageInstall()`
(`packages/pi-host/src/offline-package-resolution.ts`), which scopes the SDK's
`PI_OFFLINE` flag. Missing packages are skipped and reported instead of
fetched; the user installs them from the Packages page.

Package mutation reconcile is deliberately **not** wrapped: there, fetching is
the point. That reload remains uncancellable, bounded only by Host shutdown.

Do not set `PI_OFFLINE` globally — it would also disable the update-check
capability. The scoping is safe because every reload call site runs under
`serviceGraphLock`.

## Pre-migration backup

Before the 0.82.1 runtime first touches a real agent directory, the Host copies
the pre-migration user data to:

```text
<agentDir>/backups/pideck-sdk-0.80.7-to-0.82.1/<timestamp>/
```

It holds `auth.json`, `models.json`, `models-store.json`, and `settings.json`
(each if present), plus `session-headers.jsonl` — one header line per session,
not conversation bodies. `manifest.json` records sizes and SHA-256 digests but
never file contents, so it is safe to attach to a bug report. The directory is
`0700` and the copies are forced to `0600` regardless of the source mode.

The backup is not deleted when the Host starts successfully. Migration is
declared complete only after every dependent path has succeeded at least once,
possibly across several runs: runtime creation, a local refresh, opening a
pre-existing session, a provider snapshot, and a clean shutdown. Progress lives
in `state.json` beside the backup; once `completedAt` is set the Host skips the
whole mechanism.

If the backup cannot be written, startup fails. Migrating user data that cannot
be rolled back is worse than refusing to start.

## Commands

| Command | Purpose |
|---|---|
| `pnpm typecheck` | Typecheck protocol, pi-host, desktop |
| `pnpm test` | Unit + host integration tests |
| `pnpm build` | Build all JS packages |
| `pnpm verify:quick` | Docs + typecheck + unit/Host integration tests for local iteration |
| `pnpm verify:p0` | Pull-request P0 gate: quick + production frontend build + Rust tests |
| `pnpm package:release` | Build a Windows x64 NSIS development candidate (Windows only) |
| `pnpm dev:host` | Run Pi Host (JSONL on stdio) |
| `pnpm spike:sidecar` | M0 Extension load spike |
| `pnpm dev:desktop` | Vite UI only |
| `pnpm --filter @pideck/desktop tauri:dev` | Full desktop |
| `pnpm dev:fast` | Reuse a compiled debug binary for faster Windows iteration (Windows only) |

`verify:p0` is intentionally broader than the lightweight local gate, but it
is still not installer evidence. It has run successfully on Apple Silicon
macOS and is the tracked CI gate on Windows. See [P0 scope](./p0-scope.md).

The Rust gate uses the isolated
`apps/desktop/src-tauri/target/verify-rust` directory. This keeps P0
verification repeatable while a development build from the default target
directory is open.

## Temporary agent directory

All write tests **must** set:

```powershell
# PowerShell
$env:PI_CODING_AGENT_DIR = "$env:TEMP\pideck-test-agent"
```

Or pass `--agent-dir=<path>` to the host. Never point tests at real `~/.pi/agent` for mutations.

On macOS and other POSIX shells, use a temporary directory outside the real
agent data, for example:

```bash
export PI_CODING_AGENT_DIR="${TMPDIR:-/tmp}/pideck-test-agent"
```

## Manual host smoke

```powershell
$env:PI_CODING_AGENT_DIR = "$env:TEMP\pi-host-smoke"
pnpm --filter @pideck/pi-host exec tsx src/main.ts
# stdin:
# {"protocolVersion":1,"id":"1","method":"system.hello","context":{},"params":{"clientName":"cli","clientVersion":"0","protocolVersion":1}}
```

Use the equivalent `export PI_CODING_AGENT_DIR=...` syntax on macOS.

## Common issues

| Symptom | Check |
|---|---|
| Spike fails on Extension load | Node ≥22.19, SDK matches the Host manifest, fixture path exists |
| Host fatal on start | `agentDir` writable; inspect stderr JSON logs |
| `flush stdin: 管道正在被关闭` / pipe closed | Fixed: Windows must not pass `\\?\` paths to Node. Rebuild Tauri (`tauri:dev` again) after pulling. Also run `pnpm build` first. |
| Reveal/open path does nothing on macOS | Known limitation: the current non-Windows native path still invokes `xdg-open` instead of Finder's `open` command |
| STALE_REVISION everywhere | UI must update identity from each response |
| Tauri can't find host | Build `packages/pi-host` so `dist/main.js` exists |
