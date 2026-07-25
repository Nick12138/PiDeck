# Findings: rpiv-ask-user-question UI compatibility audit

## Requirements
- Inspect the `rpiv-ask-user-question` extension.
- Assess whether PiDeck's extension UI adaptation can handle its TUI option prompts.
- Base the conclusion on actual payloads and PiDeck's end-to-end handling.

## Research Findings
- The exact extension is not vendored in the workspace and was not found under `/Users/apple` within the initial bounded search.
- The repository contains a dedicated `test-fixtures/pi-packages/ui-extension` fixture, suggesting extension UI behavior is already modeled in tests.
- The user's working hypothesis is that `rpiv-ask-user-question` follows the same path as `/mcp`: PiDeck opens an extension terminal and forwards terminal input, rather than rendering a native structured form.
- Initial workspace text search found no literal references to the extension name, so its implementation must be obtained from installed package metadata, registry/source, or known Pi extension APIs.
- PiDeck depends on `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` version `0.80.7`; the agent package has a local patch.
- The UI fixture exercises the full built-in extension UI contract after `ctx.hasUI`: `ui.select`, `ui.confirm`, `ui.input`, and `ui.custom`, plus `setStatus` and `notify`.
- `ui.custom` returns a TUI component with `render()` and `handleInput()`, so it inherently requires a terminal-like renderer/input loop. Built-in `select`/`confirm`/`input` may be adapted separately by the host.
- PiDeck has both a native `ExtensionUiModal.tsx` and an `ExtensionTerminal.tsx`, backed by `extension-terminal-bus.ts`. The existence of both means `/mcp` and the target extension must be classified by which UI method they invoke, not merely that both are extensions.
- PiDeck's host comments define the custom-panel route precisely: `ui.custom()` is executed by a real `pi-tui` `TUI` over `VirtualTerminal`; ANSI output is emitted as `extensionUi.customFrame`, xterm.js sends input back through `extensionUi.customInput`, and resize uses `extensionUi.customResize`.
- The desktop terminal empty-state text explicitly names `/mcp` as an example extension panel. This supports the user's hypothesis for `/mcp`, but does not yet establish that `rpiv-ask-user-question` calls `ui.custom()`.
- The protocol also has a separate `extensionUi.request` channel for structured built-ins, so the target plugin's method choice remains decisive.
- `rpiv-ask-user-question` is not published under that exact unscoped name in the public npm registry (404 on 2026-07-26).
- Structured request kinds are `select`, `confirm`, `input`, and `editor`; each request carries one title/message and (for selection) one flat option list. This is adequate for a sequence of single questions, but not inherently a multi-question form in one request.
- The current published package is `@juicesharp/rpiv-ask-user-question` version `2.1.0` (published 2026-07-23). Its package metadata points to `juicesharp/rpiv-mono/packages/rpiv-ask-user-question`.
- The old standalone repository `juicesharp/rpiv-ask-user-question` still exists, while the npm package now points to the monorepo. Audit the npm release as authoritative and compare the standalone source only for compatibility history.
- Version 2.1.0 registers an `ask_user_question` model tool, not a slash command. One call can contain up to four questions, each with 2-4 described options; the terminal-native experience is one custom tabbed overlay.
- The extension explicitly distinguishes host modes. In `ctx.mode === "rpc"`, it skips the custom TUI import and calls `runRpcQuestionnaire`, which walks the questionnaire using only `ctx.ui.select` and `ctx.ui.input`.
- In RPC mode, questions appear sequentially as host-native dialogs, not in PiDeck's extension terminal. Single-select uses `select`; choosing `Type something.` opens a follow-up `input`. Multi-select uses `input` with comma-separated option numbers. Closing any dialog cancels the whole questionnaire.
- The extension documentation lists the expected RPC degradation: no tab bar/submit review, previews folded into titles and truncated, and multi-select entered as text. It promises the same structured result envelope despite the degraded presentation.
- PiDeck binds SDK extensions with RPC mode according to the host bridge's public contract/comment. If the runtime propagates this mode to tool execution context as expected, v2.1.0 will deliberately take its dialog fallback instead of `ui.custom()`.
- PiDeck's dialog bridge maps `ui.select(title, string[])` losslessly to `extensionUi.request` with each original string used as both option `id` and `label`; responding with the clicked `id` therefore returns exactly the string that the plugin's leading-number parser expects.
- `ui.input` returns any resolved string verbatim and returns `undefined` on cancellation. This matches both the plugin's free-text answer path and multi-select parser.
- The plugin awaits questions serially, and PiDeck clears the current modal after a successful response before the next request can be emitted. PiDeck also has an explicit queue for concurrent extension requests and tests queue advancement/context preservation.
- Cancellation semantics align: Escape/Cancel sends `status: cancelled`; the host resolves `undefined`; the plugin stops the questionnaire and returns partial answers with `cancelled: true`.
- Both sides use a 120-second default timeout. PiDeck's host resolves an expired request to `undefined`, which the plugin treats as cancellation. The frontend independently drops the expired modal and notifies the user.
- Presentation gap: the plugin folds previews and multi-select instructions into multi-line dialog titles, but `ExtensionUiModal` renders the title in a normal `<h2>` with no whitespace-preserving style and the modal has no max-height/overflow container. Newlines/markdown/code formatting collapse, and large previews can make the modal exceed the viewport.
- UX degradation: selection is a list of buttons navigable by Tab/click, not arrow keys; input is a textarea submitted by clicking OK (no Enter shortcut). Functionality remains available, but it does not match the plugin's TUI keyboard ergonomics.
- PiDeck mounts the native modal globally above the chat/settings layout, so it remains visible regardless of the current page. Custom panels instead open in the right dock and stream through xterm.js.
- The local Pi configuration confirms the `/mcp` comparison is `pi-mcp-adapter` version `2.13.0`, registered as a slash command named `mcp`. The target `rpiv-ask-user-question` package is not currently installed in this Pi agent directory.
- The exact installed Pi SDK runtime has an extension runner `mode` field and `setUIContext(uiContext, mode)`. PiDeck calls `bindExtensions(... mode: "rpc")`, while the SDK's interactive TUI calls it with `mode: "tui"`; this is runtime behavior, not only a type/comment convention.
- SDK runtime tracing closes the mode-propagation question: extension tools are wrapped with `runner.createContext()`, whose live `mode` getter returns the runner mode set by `bindExtensions`. Therefore the target plugin will observe `ctx.mode === "rpc"` in PiDeck 0.80.7.
- `/mcp` is definitively a different route: `pi-mcp-adapter@2.13.0` calls `ctx.ui.custom(...)` for setup, status/config, and auth panels. PiDeck routes those custom components through `VirtualTerminal` and xterm.js in the right dock.
- PiDeck's real-loader integration test already covers both families end to end through the SDK: `select`/`confirm`/`input` requests and a `custom` panel are loaded from an actual extension, bound in RPC mode, responded to, and asserted for returned values/frames/closure.
- Focused verification passed: host extension UI bridge/lifecycle/virtual-terminal/integration 35 tests; desktop store/expiry/terminal-bus 29 tests; protocol validation/coverage 303 tests. Total: 367 passing tests across 10 files.
- None of the audited PiDeck extension UI files have user worktree modifications; unrelated Rust/docs changes remain untouched.
- A direct execution check against the extracted 2.1.0 `runRpcQuestionnaire` passed: two questions produced `select` then `input`, returned the expected single/multi answer envelope, and propagated cancellation correctly.
- Version history matters: published version `1.20.0` has no RPC fallback and calls only `ctx.ui.custom()`. PiDeck's custom bridge supports the facilities that implementation uses: real `TUI`, overlay options, overlay handle callback, keybindings, terminal frames/input/resize, and `done()` lifecycle. Thus 1.20.0 should open in the extension terminal, whereas 2.1.0 opens native dialogs.
- PiDeck does not expose raw `onTerminalInput` in its UI context. For 2.1 this does not matter because RPC mode exits before the custom path. If a future/plugin variant forces the TUI path and uses the collapse-to-transcript feature, collapsing may not be reopenable from the hidden overlay.
- UI/UX checklist cross-check confirms the presentation gaps are material: long dialog content needs bounded viewport scrolling, all actions need efficient keyboard access and visible focus, and textareas need an associated visible label. The modal uses semantic buttons and a focus trap, but lacks explicit focus-ring styling, a textarea label, and a bounded/scrollable outer dialog.
- The option rows themselves are bounded by `max-h-60 overflow-auto`, so large option lists are safe; the unsafe content is the title/preview area above them.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Trace producer and consumer independently before comparing | Avoid assuming the protocol from names or screenshots. |
| Separate functional compatibility from UI parity | The plugin intentionally degrades in RPC hosts; success must cover both returned answers and usable presentation. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Exact extension name not found in npm | Continue with GitHub/source search and local Pi package conventions. |
| `/mcp` source search was initially too broad and had a quote error | Resolve package paths first, exclude maps/docs, and search fixed strings in runtime sources. |

## Resources
- `test-fixtures/pi-packages/ui-extension/package.json`
- `test-fixtures/pi-packages/ui-extension/extensions/ui-blocking-extension.ts`
- `packages/pi-host/src/extension-ui-bridge.ts`
- `packages/pi-host/src/virtual-terminal.ts`
- `apps/desktop/src/features/chat/ExtensionUiModal.tsx`
- `apps/desktop/src/features/dock/ExtensionTerminal.tsx`
- https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question
- https://github.com/juicesharp/rpiv-ask-user-question
- https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question
