# Protocol

Transport: **JSONL** over stdin (requests) / stdout (responses + events). UTF-8. One JSON object per line. stderr = logs only.

Outbound backpressure (`packages/pi-host/src/outbound-queue.ts`): all output flows through one bounded queue that honors stream drain. Event sequences are normally allocated at write time; above a 1MB soft watermark, latest-wins events coalesce and terminal frames merge; above a 16MB hard cap, droppable events are shed and — in the extreme — a sequence gap is forced deliberately so the client's gap detection triggers its standard rehydrate recovery. Responses are never dropped. The atomic recovery barrier is the one exception to write-time allocation: it seals all earlier live events with sequence numbers and prevents coalescing across the barrier before it captures the response watermark.

## Identity & revisions

Every Host process has a new `hostInstanceId`. Monotonic:

- `workspaceRevision` — workspace graph replacement
- `sessionRevision` — session create/open/reload/dispose
- `packageRevision` — package snapshot publish
- `ToolSnapshot.revision` — within a session generation, starts at 1

Frontend **must drop** events/responses with mismatched `hostInstanceId`. Stale expected identity returns `STALE_REVISION`.

## Methods (P0)

Implemented in `packages/protocol` + handlers in `packages/pi-host`:

- `system.hello` / `getStatus` / `rehydrate` / `shutdown`
- `workspace.setCurrent` / `getCurrent`
- `session.*` (list, create, open, snapshot, name, entries, tree, stats)
- `agent.*` (prompt, steer, followUp, abort, queue, compact, tools, …)
- `model.list` / `setCurrent` / `setThinkingLevel`
- `package.*` / `resource.setPreference` / `resource.setPreferences`
- `piSettings.get` / `patch`
- `extensionUi.respond` / `customInput` / `customResize`

Desktop-only (Rust, not Host): `desktopSettings.get` / `patch`, `desktop.openPath`, and
`shell_terminal_create` / `write` / `resize` / `close`. The real Shell terminal uses
`portable-pty` plus a Tauri Channel directly between Rust and xterm.js; it intentionally
stays outside Host identity/revision epochs, so restarting Pi Host does not terminate it.

## Events

See `HOST_EVENT_NAMES` in `packages/protocol/src/events.ts`. Notable:

- `host.ready`, `host.statusChanged`, `host.fatal`
- `workspace.changed`
- `session.snapshot`, `agent.event`, `agent.toolsChanged`
- `package.progress`, `package.snapshot`
- `extensionUi.request` / status / widget / notification
- `extensionUi.customStarted` / `customFrame` / `customClosed` — ui.custom() panels: the host runs a real pi-tui TUI over a virtual terminal (`packages/pi-host/src/virtual-terminal.ts`) and streams its ANSI output as frames; the desktop renders them in an xterm.js dock panel and feeds keyboard input back via `extensionUi.customInput`

## Runtime validation

`parseHostRequest` in `packages/protocol/src/validate.ts` validates method, context scope (no extra keys), and params. Context scope map: `METHOD_CONTEXT_SCOPE`.

## Atomic recovery

`system.rehydrate` returns one composite `{ watermark, host, workspace, session, tools, packages }` snapshot. The Host captures the graph state and queues the outbound sequence-barrier response in the same JavaScript turn, so the watermark is the exact boundary represented by the snapshot.

Before requesting it, the desktop opens a bounded same-Host event buffer. It installs the composite snapshot at the returned watermark, then replays buffered events with larger sequences through the normal reducer path. A buffer overflow or replay gap starts a fresh recovery rather than advancing state past an unapplied event.

## Timeouts (client guidance)

| Op | Timeout |
|---|---:|
| hello/status/list | 10s |
| rehydrate | 15s |
| session create | 30s |
| session open | 180s (includes blocking extension startup UI) |
| package install/update | 10 min |
| shutdown | 10s then Rust force-kill |
