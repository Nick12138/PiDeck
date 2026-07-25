# Chat runtime

## Status

**Implemented:** Session list/create/open, prompt/steer/follow-up/abort, model/thinking selectors, transcript rendering, tool cards, Extension UI modal, and AUTH_REQUIRED banner.

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
| Tools panel | `agent.getTools` / `agent.setActiveTools` |

Tool Result `addedToolNames` → Host publishes full `agent.toolsChanged` (no client-side tool schema invention).

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

**Binding (SDK 0.80.7):** Host calls only public

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
