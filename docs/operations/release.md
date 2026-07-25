# Release and Packaging

PiDeck does not currently provide a certified public installer. Source
development and release packaging are separate support levels:

| Platform | Source development | Development package | Public release |
|---|---|---|---|
| Windows 11 x64 | Supported | NSIS candidate | Not yet signed or accepted |
| Apple Silicon macOS | Supported for early testing | Not implemented | Not available |

The tracked implementation requirements in
[`p0-status.json`](./p0-status.json) are implemented, but `claimStatus` remains
`not-complete`. A passing `pnpm verify:p0` establishes source readiness; it is
not installer or release evidence.

## Windows Development Candidate

Run the following on Windows 11 x64:

```powershell
pnpm install --frozen-lockfile
pnpm package:release
```

`package:release` prepares and validates the bundled runtime, builds the
frontend and Tauri application, creates an NSIS installer, and applies the
repository's Windows installer-integrity checks. It writes candidate evidence
under `artifacts/p0/release-latest/`.

The candidate contains:

1. The Tauri desktop application and NSIS installer.
2. A pinned Windows x64 Node.js distribution.
3. The production Pi Host and Pi SDK dependency tree.
4. Pinned Portable Git for Git-based Package sources.

The exact runtime inputs are pinned by
[`scripts/release-runtime.lock.json`](../../scripts/release-runtime.lock.json).
The packaging path, runtime lock, Tauri bundle target, and integrity inspection
are all Windows-specific.

## Source Verification

Use the same source gates on Windows and macOS:

```bash
pnpm verify:quick
pnpm verify:p0
```

`verify:quick` checks documentation, types, and JavaScript/TypeScript tests.
`verify:p0` also builds the production frontend and runs Rust tests. GitHub
Actions currently runs `verify:p0` on `windows-2022`; Apple Silicon macOS has
also passed the command locally.

These commands do not install, sign, launch, or uninstall a packaged
candidate. They therefore cannot authorize a public-release claim.

## macOS Boundary

Apple Silicon macOS can run the complete development application with:

```bash
pnpm build
pnpm --filter @pideck/desktop run tauri:dev
```

There is no macOS runtime lock, Tauri app/DMG target, signing identity,
notarization workflow, or packaged-app smoke evidence yet. Do not use
`package:release` or `dev:fast` on macOS.

The current `desktop_open_path` implementation also invokes `xdg-open` for all
non-Windows systems, so revealing paths in Finder is a known development-mode
limitation.

## Public Release Requirements

Before publishing any installer as a supported release:

- Build from a clean, identified commit with locked dependencies.
- Run the source gate on that exact revision.
- Produce platform-native packaging and installed-app smoke evidence.
- Verify startup without global Node or Git dependencies and audit orphan
  processes after exit and uninstall.
- Sign and timestamp the installer, then verify the signature before accepting
  final hashes.
- Archive the evidence and update `p0-status.json` only after human acceptance.

For Windows, this requires Authenticode signing in addition to the current
integrity checks. For macOS, it requires a separate app/DMG packaging, signing,
and notarization implementation.

The deferred production checklist is preserved in
[release-checklist.md](./release-checklist.md). Historical hardening evidence
and invalidated candidates remain documented in
[remediation-report.md](./remediation-report.md); those records do not describe
the current command surface.

## Rollback and User Data

Keep the previously accepted installer when testing an update. PiDeck user data
lives in the configured Pi agent directory, not inside the application bundle.
Packaging and uninstall tests must never use a real user data directory.
