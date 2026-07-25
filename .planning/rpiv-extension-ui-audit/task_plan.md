# Task Plan: rpiv-ask-user-question UI compatibility audit

## Goal
Determine whether PiDeck's extension UI handling correctly supports the interactive questions emitted by `rpiv-ask-user-question`, with evidence from both implementations and focused verification.

## Next Step
Deliver the compatibility conclusion and identified UI gaps.

## Current Phase
Complete

## Phases

### Phase 1: Locate and map both sides
- [x] Find the installed or vendored extension implementation
- [x] Find PiDeck extension UI event, state, and rendering code
- **Status:** complete

### Phase 2: Compare contracts and behavior
- [x] Extract the extension's actual request/response shapes
- [x] Trace PiDeck handling for every question mode and lifecycle state
- **Status:** complete

### Phase 3: Verify and report
- [x] Run focused tests or fixtures where feasible
- [x] Report supported behavior, gaps, severity, and concrete references
- **Status:** complete

## Key Questions
1. Which extension UI protocol/API does the plugin use?
2. Are option selection, multiple questions, text input, cancellation, and response serialization supported?
3. Does PiDeck preserve ordering and correctly unblock the extension request?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Keep this audit read-only except planning notes | The user asked for compatibility assessment, not implementation changes. |
| Use a scoped planning directory | Preserve the existing root task plan and unrelated worktree changes. |
| Classify as functionally compatible with UI-parity gaps | Requests complete correctly, but the RPC presentation loses important TUI affordances and mishandles rich preview layout. |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| `npm view rpiv-ask-user-question` returned npm registry 404 | 1 | Treat the name as a repository/local Pi package identifier and search source registries directly. |
| A shell search pattern for `/mcp` had an unmatched quote | 1 | Avoid compound quote escaping; resolve the package symlink and use simple fixed-string searches excluding source maps. |
| Broad SDK search included multi-megabyte source maps | 1 | Restrict subsequent searches with `--glob '!*.map'` and target resolved runtime files. |
| Root `node_modules/@earendil-works/...` symlink did not exist and broad node_modules search matched unrelated MCP SDKs | 2 | Locate the workspace-package symlink exactly and inspect only that resolved package; inspect Pi agent manifests rather than recursively searching dependency trees. |
| Root `pnpm exec tsx` could not resolve `tsx` | 1 | Run it through the package that declares `tsx`: `pnpm --filter @pideck/pi-host exec tsx`. |
| `tsx -e` transformed the plugin's top-level-await module as CJS | 2 | Use a temporary `.mts` runner so the published ESM module remains ESM. |
