import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "@pideck/protocol";
import { extractLatestTodos } from "./todo-model";

function session(messages: SessionSnapshot["messages"]): SessionSnapshot {
  return {
    sessionId: "session-1",
    cwd: "/tmp/project",
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    pending: { revision: 0, steering: [], followUp: [] },
    messages,
    tools: {
      revision: 1,
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };
}

describe("extractLatestTodos", () => {
  it("returns the latest complete TodoWrite call", () => {
    const result = extractLatestTodos(
      session([
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "TodoWrite",
              id: "todo-1",
              arguments: {
                todos: [
                  { id: "a", content: "Inspect the app", status: "completed" },
                  { id: "b", content: "Build the panel", status: "in_progress", activeForm: "Building the panel" },
                ],
              },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "TodoWrite",
              id: "todo-2",
              arguments: JSON.stringify({
                todos: [{ id: "c", content: "Run tests", status: "pending" }],
              }),
            },
          ],
        },
      ]),
    );

    expect(result).toEqual([{ id: "c", content: "Run tests", status: "pending" }]);
  });

  it("ignores incomplete or unrelated tool calls", () => {
    const result = extractLatestTodos(
      session([
        { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "TodoWrite",
              arguments: { todos: [{ content: "Missing status", status: "unknown" }] },
            },
          ],
        },
      ]),
    );

    expect(result).toEqual([]);
  });

  it("accepts the lowercase todo tool spelling", () => {
    const result = extractLatestTodos(
      session([
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "todo_write",
              arguments: { todos: [{ content: "Write docs", status: "completed" }] },
            },
          ],
        },
      ]),
    );

    expect(result[0]?.status).toBe("completed");
  });

  it("reads tool_use calls from the persisted entry path", () => {
    const current = session([]);
    current.entries = [
      {
        id: "entry-1",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "TodoWrite",
              input: { todos: [{ content: "Show the task panel", status: "in_progress" }] },
            },
          ],
        },
      },
    ];

    expect(extractLatestTodos(current)).toEqual([
      { id: "0", content: "Show the task panel", status: "in_progress" },
    ]);
  });
});
