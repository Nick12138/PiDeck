# Pi SDK 0.82.1 Upgrade

## Baseline

- Source commit: `8859c1e414c368d762ffab8f0f0a23ea3f4e483f`
- Annotated tag: `pre-pi-sdk-0.82.1-8859c1e414c`
- Pi SDK packages: `0.80.7`
- Minimum development Node: `22.19.0`
- Controlled release Node: `24.18.0`
- pnpm: `9.15.0`

## Baseline Artifacts

- `pnpm-lock.yaml` SHA-256: `a92c3c10f44c0bfcb8a80b8588ff798d9d5b2cdde0e618d4784eee4eb8790af6`
- `patches/@earendil-works__pi-coding-agent@0.80.7.patch` SHA-256: `ef9e0f8e9bc6eddc8005e5f425c140d2a52cc0072c4115a0a553ddaedac6baca`

The release lock had retained the pnpm-lock hash from commit `1e9266f`. Later lockfile changes in `d202930`, `c65ac7c`, and `eaa8b6c` were source-compatible but were not repinned. PR-0A repairs that pre-existing release-baseline drift before changing Node or Pi SDK versions.

## Verification

- macOS frozen install: passed
- macOS docs, typecheck, and JavaScript/TypeScript tests: passed
- macOS production build: passed
- macOS Rust tests: 34 passed
- Windows controlled runtime staging: required in CI
- Windows staged resource validation: required in CI
- Windows staged Host smoke: required in CI

The staged Host smoke launches the generated compacted bootstrap with the controlled Node runtime and an isolated `PI_CODING_AGENT_DIR`. It requires `host.ready`, `system.getStatus`, atomic `system.rehydrate`, exact `system.shutdown`, and a zero process exit.

## Upgrade Boundaries

- Keep Pi SDK at `0.80.7` through lifecycle and release-version-source prerequisites.
- Upgrade `pi-ai`, `pi-coding-agent`, and `pi-tui` to `0.82.1` in one atomic migration.
- Preserve Node `>=22.19.0` as the minimum compatibility contract.
- Do not produce a release candidate until the announced post-2026-07-27 Node 24 security release is pinned by URL and SHA-256.

## Rollback Anchor

Rollback restores the complete previous signed artifact, its release runtime lock, its pnpm lockfile, and the `0.80.7` SDK patch. Do not replace individual npm packages inside an installed artifact.
