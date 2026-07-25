# Progress Log: rpiv-ask-user-question UI compatibility audit

## Session: 2026-07-26

### Phase 1: Locate and map both sides
- **Status:** complete
- Actions taken:
  - Read the `planning-with-files` workflow and session catch-up state.
  - Preserved the existing root plan and unrelated modified files.
  - Created a scoped, read-only audit plan.
  - Searched the workspace and user directory for the extension; it is not locally vendored or installed under an obvious matching path.
  - Identified the repository's UI extension test fixture and added `/mcp` versus extension-terminal routing to the audit scope.
  - Confirmed PiDeck intentionally supports both native extension UI methods and a virtual terminal for custom TUI components.
  - Traced the custom TUI transport: host-side `VirtualTerminal` to frame events, frontend xterm input/resize back to the live component.
  - Located the current scoped npm package and its monorepo source after the unscoped lookup failed.
  - Downloaded and extracted the exact published `2.1.0` tarball outside the workspace.
  - Established that the current plugin has an explicit RPC dialog fallback and does not use its full custom TUI in RPC hosts.

### Phase 2: Compare contracts and behavior
- **Status:** complete
- Actions taken:
  - Began comparing the plugin's sequential RPC dialog walker with PiDeck's native request queue and modal response flow.
  - Verified value serialization, question sequencing, cancellation, session identity migration, and timeout behavior.
  - Identified a display-quality gap for multiline/large preview content and reduced keyboard ergonomics in PiDeck's native modal.
  - Confirmed the local `/mcp` implementation is `pi-mcp-adapter@2.13.0` and narrowed the SDK runtime check to the exact resolved package.
  - Proved SDK `mode: rpc` reaches model-tool execution contexts via `runner.createContext()`.
  - Proved `/mcp` explicitly uses `ui.custom()` while the target plugin v2.1 uses `select`/`input` in PiDeck.
  - Ran 10 focused test files: all 367 tests passed, including the real SDK loader integration and both dialog/custom transports.
  - Executed the published plugin's RPC walker directly for sequential single-select, multi-select, and cancellation; assertions passed.
  - Compared version 1.20.0 and confirmed older releases use PiDeck's custom extension-terminal path instead.
  - Applied the UI/UX review checklist to the native modal; confirmed bounded-content, labeling, focus visibility, and keyboard-efficiency gaps.

### Phase 3: Verify and report
- **Status:** complete
- Actions taken:
  - Completed focused automated and direct package execution checks.
  - Classified PiDeck as functionally compatible with `2.1.0`, while documenting RPC presentation and accessibility gaps.
- Files created/modified:
  - Planning notes only; no application source changed.
- Files created/modified:
  - `.planning/rpiv-extension-ui-audit/task_plan.md`
  - `.planning/rpiv-extension-ui-audit/findings.md`
  - `.planning/rpiv-extension-ui-audit/progress.md`
- Files created/modified:
  - `.planning/rpiv-extension-ui-audit/task_plan.md`
  - `.planning/rpiv-extension-ui-audit/findings.md`
  - `.planning/rpiv-extension-ui-audit/progress.md`

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Host extension UI | bridge, lifecycle, virtual terminal, real-loader integration | All pass | 35/35 passed | Pass |
| Desktop extension UI | request store, expiry, terminal UI/bus | All pass | 29/29 passed | Pass |
| Protocol extension UI | validation and event/method coverage | All pass | 303/303 passed | Pass |
| Published plugin RPC walker | single select, multi-select, cancellation | Ordered dialogs and correct result shapes | Matched | Pass |

## Error Log
| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-07-26 | npm registry returned 404 for exact extension name | 1 | Switched to repository/source discovery. |
| 2026-07-26 | `/mcp` shell search had unmatched quoting; SDK search pulled source maps | 1 | Narrowed search strategy to resolved packages and non-map runtime files. |
| 2026-07-26 | Root SDK symlink assumption was wrong and broad MCP search was noisy | 2 | Switching to exact workspace symlinks and Pi package manifests. |
| 2026-07-26 | Root `pnpm exec tsx` unavailable | 1 | Use the pi-host package-local executable. |
| 2026-07-26 | `tsx -e` rejected plugin top-level await under CJS output | 2 | Switching to a temporary ESM `.mts` runner. |
