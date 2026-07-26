import { toJsonValue, type SerializableAgentSessionEvent } from "@pideck/protocol";

type EventRecord = Record<string, unknown>;

const EVENT_FIELDS = {
  agent_start: [],
  agent_end: ["messages", "willRetry"],
  turn_start: [],
  turn_end: ["message", "toolResults"],
  message_start: ["message"],
  message_update: ["message", "assistantMessageEvent"],
  message_end: ["message"],
  tool_execution_start: ["toolCallId", "toolName", "args"],
  tool_execution_update: ["toolCallId", "toolName", "args", "partialResult"],
  tool_execution_end: ["toolCallId", "toolName", "result", "isError"],
  agent_settled: [],
  queue_update: ["steering", "followUp"],
  compaction_start: ["reason"],
  entry_appended: ["entry"],
  session_info_changed: ["name"],
  thinking_level_changed: ["level"],
  compaction_end: ["reason", "result", "aborted", "willRetry", "errorMessage"],
  auto_retry_start: ["attempt", "maxAttempts", "delayMs", "errorMessage"],
  auto_retry_end: ["success", "attempt", "finalError"],
  error: ["error", "message"],
} as const satisfies Record<string, readonly string[]>;

type SupportedEventType = keyof typeof EVENT_FIELDS;

/** Normalize reviewed AgentSession fields for the JSONL Host/Desktop boundary. */
export function normalizeAgentEvent(event: unknown): SerializableAgentSessionEvent {
  if (!isRecord(event) || typeof event.type !== "string" || !isSupportedEvent(event.type)) {
    return { type: "unknown" };
  }

  const type = event.type;
  const out: EventRecord = { type };
  for (const field of EVENT_FIELDS[type]) {
    if (!Object.hasOwn(event, field) || event[field] === undefined) continue;
    if (type === "tool_execution_end" && field === "result") {
      out.result = normalizeToolResult(event.result);
    } else if (type === "tool_execution_update" && field === "partialResult") {
      out.partialResult = normalizeToolResult(event.partialResult);
    } else {
      out[field] = toJsonValue(event[field]);
    }
  }

  return out as SerializableAgentSessionEvent;
}

function isSupportedEvent(type: string): type is SupportedEventType {
  return Object.hasOwn(EVENT_FIELDS, type);
}

function isRecord(value: unknown): value is EventRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolResult(result: unknown): unknown {
  if (!isRecord(result)) return toJsonValue(result);
  const out: EventRecord = {
    content: toJsonValue(result.content ?? []),
    details: toJsonValue(result.details ?? null),
  };
  if (Array.isArray(result.addedToolNames)) {
    out.addedToolNames = result.addedToolNames.filter((name) => typeof name === "string");
  }
  if (typeof result.terminate === "boolean") {
    out.terminate = result.terminate;
  }
  return out;
}
