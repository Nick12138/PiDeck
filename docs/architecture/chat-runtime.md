# Chat runtime

## Status

**Implemented:** Session list/create/open, prompt/steer/follow-up/abort, manual/auto compaction controls, model/thinking selectors, transcript rendering, tool cards, Extension UI modal, and AUTH_REQUIRED banner.

## Session

- Listed only for current workspace cwd (`session.list`).
- `session.open` rejects paths not in that list (must switch workspace first).
- React owns a normalized, workspace-scoped Session Catalog. Page navigation does not clear it.
- Active Pi snapshots project `running`, `queued`, `idle`, `error`, or `inactive` state into the Catalog.
- Composer drafts are keyed by Session id, so switching pages or Sessions does not discard input.
- Host exposes one foreground AgentSession plus retained background runtimes. Running Sessions remain live, while idle Sessions are kept in a bounded reuse cache (currently three entries).
- Background runtimes publish Session status but not Transcript deltas into the foreground projection. Evicted runtimes can be reopened from Pi's Session file.
- Final AgentSession disposal must emit `session_shutdown` before `AgentSession.dispose()`. Extensions use that event to release timers, watchers, and other work that captures the current extension context.
- Opening a still-running background Session promotes the existing Runtime, assigns a new Session revision, rebuilds the foreground snapshot, and migrates Extension UI identity without restarting the turn.
- `session.list` includes `runtimeState` and `sessionRevision`, allowing a reconnecting UI to rebuild the runtime status of foreground and retained background Sessions.

## Agent commands

| UI action | Method |
|---|---|
| Send (idle) | `agent.prompt` |
| Send (busy) | `agent.steer` or `agent.followUp` |
| Stop | `agent.abort` |
| Stop (compacting) | `agent.abortCompaction` |
| `/compact [instructions]` or Compact now | `agent.compact` |
| Auto-compaction switch | `agent.setAutoCompaction` |
| `/session` stats dialog | `session.getStats` |
| `/tree` dock panel | `session.getTree` / `agent.navigateTree` |
| `/fork` selector or tree fork button | `session.getForkPoints` / `session.fork` |
| `/export [html\|jsonl]` or stats-dialog buttons | `session.export` |
| Tools panel | `agent.getTools` / `agent.setActiveTools` |

Tool Result `addedToolNames` → Host publishes full `agent.toolsChanged` (no client-side tool schema invention).

The Composer's `/` completion merges `session.getCommands` (prompt templates,
extension commands, skills) with PiDeck's built-in commands
(`features/chat/builtin-commands.ts`, currently `/compact`, `/session`,
`/tree`, `/fork`, and `/export`). A
draft matching a built-in command runs locally instead of being sent to the
model; unknown `/name` text still goes to the model unchanged. Manual
compaction requires an idle agent and shares the per-session operation lock
with `agent.prompt`. The context-usage ring in the Composer opens a panel with
the usage breakdown, a Compact now action, and the auto-compaction switch.
`/session` opens a dialog with message, token, and cost aggregates from
`session.getStats`, which the Host builds from `AgentSession.getSessionStats()`
(whole-history aggregates, including compacted-away entries). `/tree` opens the
Tree page in the right dock: it renders `session.getTree` as conversation
turns only — tool results, model changes, and other bookkeeping entries are
collapsed, with hidden branch labels carried to their first visible
descendant and the current marker on the deepest visible row of the leaf
path. Clicking an entry calls `agent.navigateTree` (always
`summarize: false` — navigation is local, no LLM call), which shares the
per-session operation lock, requires an idle agent, and returns the rebuilt
snapshot plus optional `editorText` restored into the Composer draft. The
panel refetches on session identity changes, busy edges, navigation, and
manual refresh — never per streamed message, because every stable read
briefly takes the service graph lock. Tree, fork, and model-list requests
retry transient retryable failures (`SERVICE_GRAPH_BUSY`) through
`lib/bridge/request-retry.ts`.
`/fork` (also available as an inline button on the tree panel's user rows)
picks a user message from `session.getForkPoints`; `session.fork` then writes
a branched session file via `SessionManager.createBranchedSession` before that
message and reuses the standard `session.open` flow to switch to it, returning
the new snapshot plus the message text for the Composer draft.
`session.fork` also accepts `position: "at"`, which keeps history through the
given entry: each settled assistant turn in the transcript shows a fork
button (left of Copy) targeting the turn's last persisted entry
(`TranscriptRow.sourceEndId`). A fork of a named session is displayed as
`Fork · <source name>` (written into the forked file via
`appendSessionInfo`); unnamed sources stay unnamed so automatic titling
still runs. The tree panel groups a linear run of
assistant entries (tool-call segments) into one turn row whose navigation
target is the run's last entry; branch points break the run. Turns render as
a commit graph: filled dots are user turns, hollow dots assistant turns, the
current path is a continuous accent rail, and each concurrent branch gets its
own lane so fork connectors never overlap another branch's chain
(`flattenSessionTree` returns the lane layout). `/export` (idle-only) picks a
target through the native save dialog, `session.export` runs the SDK's
`exportToHtml` / `exportToJsonl`, and the desktop reveals the written file via
`desktop_open_path`; the Host advertises this as the `sessionExport`
capability. Unlike the CLI,
PiDeck does not emit `session_before_fork` to extensions, and the forked
session starts through the normal open path rather than a `session_start`
with reason `fork`. Forking before the first message is not supported.

## Queue transactions

- Queue state is a per-AgentSession `QueueSnapshot` with a monotonic revision.
- Edit, reorder, delete, and clear requests use compare-and-swap against the last
  rendered revision. A stale request is rejected without clearing the live queue.
- The Host suppresses the SDK's intermediate clear/re-add events and publishes one
  final `agent.queueChanged` snapshot for each logical transaction.
- Run Now is one `agent.runNow` RPC pinned to the originating Session. The Host parks
  the queue, aborts and settles the active run when necessary, starts the selected
  follow-up, then restores the remaining queue before responding.
- Queue text and queued image attachments are restored together. If an SDK enqueue
  fails, the response exposes the final queue and explicit restoration/partial-failure
  flags; the desktop never assumes the pre-request queue still exists.

## Extension UI

**Binding (SDK 0.82.1):** Host calls only public

```ts
await session.bindExtensions({ uiContext, mode: "rpc" });
```

`uiContext` implements positional `ExtensionUIContext` APIs (`select(title, options)`, `confirm(title, message)`, `input`, `editor`, `notify`, `setStatus`, `setWidget`). TUI-only methods (custom editor/footer/header factories) are no-op or throw a clear unsupported error — they never access private setters.

Blocking: select / confirm / input / editor via `extensionUi.request` + `extensionUi.respond`.  
Non-blocking: status, widget, notify.  
Cancel / timeout / session dispose → `undefined` (or confirm false).

Blocking requests and custom panels retain the Session identity captured by their
Host event, so a running background Session remains interactive without becoming
the RPC's active Session. Response, input, and resize RPCs use the `sessionTarget`
scope and must match the owner bound to their `requestId`; a foreign or stale call
has no side effects. When a background Runtime is promoted, the Host migrates the
dialog and custom-panel owners to the new Session revision. The desktop follows
that revision only when the foreground snapshot is for the same Session id, and
otherwise keeps the captured background target.

## Copy / keyboard

- Explicit Copy button copies full message.
- Standard `Ctrl+C` / `Ctrl+X` / `Ctrl+V` remain browser/WebView defaults (not overridden).
