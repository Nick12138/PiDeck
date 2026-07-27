# Extension Presentation

PiDeck supports a declarative Extension Presentation v1 contract for custom
messages and blocking Extension UI requests. The contract carries semantics and
copy, not Extension-owned HTML, React components, CSS, colors, or executable
actions.

## Custom messages

Put presentation metadata under `details.presentation`. This works with the
public SDK `sendMessage` shape and keeps the raw message available for agent
context and diagnostics.

```ts
await ctx.sendMessage({
  customType: "worker_progress",
  content: "Internal worker protocol payload",
  display: true,
  details: {
    presentation: {
      version: 1,
      extensionId: "worker-extension",
      sourceLabel: "Workers",
      audience: "user",
      kind: "progress",
      status: "running",
      correlationId: "run-42",
      groupKey: "run-42",
      title: "Reviewing the workspace",
      summary: "Two of four checks are complete."
    }
  }
});
```

PiDeck also accepts `presentation` at the top level when a producer controls the
serialized message directly. `details.presentation` is the portable SDK path.

Presentation fields:

| Field | Values / purpose |
|---|---|
| `version` | Must be `1` |
| `extensionId` | Stable Extension identifier |
| `audience` | `user` or `agent` |
| `kind` | `activity`, `progress`, `decision`, `result`, or `warning` |
| `correlationId` | Stable identifier for this logical event or request |
| `sourceLabel` | Optional user-facing Extension name |
| `status` | `pending`, `running`, `resolved`, `cancelled`, `expired`, or `failed` |
| `severity` | `neutral`, `info`, `warning`, or `danger` |
| `groupKey` | Optional identifier for related events |
| `title`, `summary` | Bounded plain text shown for `audience: "user"` |
| `actionRequestId` | Reference to a live decision request; never executable by itself |
| `technicalDetails` | JSON shown only after opening the Extension title row |

`display: false` always wins and keeps the message out of the transcript. For
`audience: "agent"`, PiDeck ignores presentation title and summary in the main
reading flow. Visible Extension activity is collected into the surrounding
assistant execution trace, so it does not create a second Pi avatar or usage
footer. Opening the trace reveals a quiet Agent coordination or Extension title
row; opening that row reveals raw content, custom type, and metadata without a
separate "Technical details" control.

A custom message with `kind: "decision"` is historical, read-only presentation.
Live controls must come from an Extension UI request so ownership, expiry, and
stale revision checks remain enforceable.

Unknown or invalid visible custom messages use a neutral, closed fallback. They
are not discarded, but they do not receive trusted semantic styling and remain
inside the same execution-trace flow.

## Blocking requests

Existing calls remain modal. Opt into the inline surface with the PiDeck
namespace on dialog options:

```ts
const approved = await ctx.ui.confirm(
  "Apply the generated migration?",
  "This changes the local database schema.",
  {
    timeout: 120_000,
    pideck: {
      presentation: "inline",
      sourceLabel: "Migration review",
      correlationId: "migration-42",
      risk: "high"
    }
  }
);
```

The same `pideck` object is supported by `select`, `input`, and the optional
third argument added to `editor`. Supported fields are:

```ts
interface PiDeckExtensionUIDialogOptions {
  presentation?: "inline" | "modal";
  sourceLabel?: string;
  correlationId?: string;
  risk?: "normal" | "high";
  allowFreeform?: boolean;
  optionDetails?: Array<{
    id: string;
    description?: string;
    destructive?: boolean;
  }>;
}
```

Standard SDK select values are used as both IDs and labels. Option metadata is
merged only when `optionDetails.id` exactly matches a sanitized select value.

```ts
await ctx.ui.select("Choose a cleanup mode", ["keep", "delete"], {
  pideck: {
    presentation: "inline",
    allowFreeform: true,
    optionDetails: [
      {
        id: "delete",
        description: "Remove generated files permanently",
        destructive: true
      }
    ]
  }
});
```

PiDeck strips terminal controls, bounds presentation strings, ignores unknown
metadata, and emits only protocol-whitelisted fields. Other UI modes ignore the
optional `pideck` namespace. Extensions compiled against an unpatched upstream
0.82.1 declaration need the PiDeck type extension (or an equivalent local type
intersection) even though the runtime option is backward compatible.

## Response lifecycle

- Inline and modal surfaces use the same `extensionUi.respond` RPC.
- Only one surface renders a request. Missing `presentation` means modal.
- Controls disable while a response is in flight.
- A failed response stays open, announces a local error, and can be retried.
- Expiry removes only the matching active request and advances the same-Session
  queue once.
- A late response cannot dismiss a newer request because queue advancement is
  guarded by `requestId` and Host-side owner identity.

The compatibility adapter for `subagent_supervisor_request` maps old pi-subagents
messages to `audience: "agent"` activity without parsing their `Reply with:`
content. Durable changes to pi-subagents should emit Presentation v1 upstream;
PiDeck does not modify the globally installed Extension package.
