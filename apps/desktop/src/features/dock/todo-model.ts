import type {
  SerializableAgentContent,
  SerializableAgentMessage,
  SerializableSessionEntry,
  SessionSnapshot,
} from "@pideck/protocol";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isTodoToolName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "todowrite" || normalized === "todo";
}

function normalizeTodo(value: unknown, index: number): TodoItem | null {
  if (!isRecord(value) || typeof value.content !== "string" || !value.content.trim()) {
    return null;
  }
  const status = value.status;
  if (status !== "pending" && status !== "in_progress" && status !== "completed") return null;
  return {
    id: typeof value.id === "string" && value.id ? value.id : String(index),
    content: value.content.trim(),
    status,
    ...(typeof value.activeForm === "string" && value.activeForm.trim()
      ? { activeForm: value.activeForm.trim() }
      : {}),
  };
}

function todoItemsFromArguments(value: unknown): TodoItem[] | null {
  const args = parseArguments(value);
  if (!args || !Array.isArray(args.todos)) return null;
  const items = args.todos.map(normalizeTodo).filter((item): item is TodoItem => item !== null);
  return items.length === args.todos.length ? items : null;
}

function todoItemsFromContent(content: SerializableAgentContent[] | string): TodoItem[] | null {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!isRecord(part)) continue;
    const toolName =
      part.name ??
      (isRecord(part.toolCall) ? part.toolCall.name : undefined) ??
      (isRecord(part.function) ? part.function.name : undefined);
    if (!isTodoToolName(toolName)) continue;
    const items = todoItemsFromArguments(
      part.arguments ?? part.args ?? part.input ?? part.parameters ?? part.toolCall,
    );
    if (items) return items;
  }
  return null;
}

function todoItemsFromMessage(value: unknown): TodoItem[] | null {
  if (!isRecord(value)) return null;
  const content = value.content;
  if (typeof content !== "string" && !Array.isArray(content)) return null;
  return todoItemsFromContent(content as SerializableAgentContent[] | string);
}

function todoItemsFromEntry(entry: SerializableSessionEntry): TodoItem[] | null {
  return entry.type === "message" ? todoItemsFromMessage(entry.message) : null;
}

/**
 * Returns the latest complete TodoWrite projection persisted in the current
 * session. Pi's tool call is the source of truth; the desktop only projects it.
 */
export function extractLatestTodos(session: SessionSnapshot | null): TodoItem[] {
  if (!session) return [];
  let latest: TodoItem[] = [];
  for (const entry of session.entries ?? []) {
    const items = todoItemsFromEntry(entry);
    if (items) latest = items;
  }
  for (const message of session.messages as SerializableAgentMessage[]) {
    const items = todoItemsFromContent(message.content);
    if (items) latest = items;
  }
  return latest;
}
