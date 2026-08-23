import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSubagentSessions, readSubagentSession } from "./subagent-session.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readSubagentSession", () => {
  it("extracts user text, thinking, tool calls, and tool results", () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-subagent-session-"));
    roots.push(root);
    const runDir = join(root, "run-abc123");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "session.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "child-session", cwd: root }),
        JSON.stringify({
          type: "message",
          id: "u1",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "Inspect this file" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "a1",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I should inspect it first." },
              { type: "text", text: "I will inspect the file." },
              { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "t1",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "tool", content: [{ type: "text", text: "file contents" }] },
        }),
      ].join("\n") + "\n",
    );

    const snapshot = readSubagentSession(root, "abc123");

    expect(snapshot).not.toBeNull();
    expect(snapshot?.sessionId).toBe("child-session");
    expect(snapshot?.entries).toHaveLength(4);
    expect(snapshot?.entries.map((entry) => entry.type)).toEqual([
      "session",
      "message",
      "message",
      "message",
    ]);
    expect(snapshot?.entries.find((entry) => entry.id === "u1")?.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Inspect this file" }],
    });
    expect(snapshot?.entries.find((entry) => entry.id === "a1")?.message).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should inspect it first." },
        { type: "text", text: "I will inspect the file." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } },
      ],
    });
    expect(snapshot?.entries.find((entry) => entry.id === "t1")?.message).toMatchObject({
      role: "tool",
      content: [{ type: "text", text: "file contents" }],
    });
  });

  it("discovers real child sessions without workflow container nodes", () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-subagent-session-"));
    roots.push(root);
    const parentId = "parent-session";
    const parentDir = join(root, "parent-file");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(
      join(root, "parent-file.jsonl"),
      JSON.stringify({ type: "session", version: 3, id: parentId, cwd: root }) + "\n",
    );
    for (const [runId, name] of [
      ["run-a", "检查内存"],
      ["run-b", "检查磁盘"],
    ] as const) {
      const childDir = join(parentDir, runId, "run-0");
      mkdirSync(childDir, { recursive: true });
      writeFileSync(
        join(childDir, "session.jsonl"),
        [
          JSON.stringify({ type: "session", version: 3, id: `${runId}-session`, cwd: root }),
          JSON.stringify({
            type: "session_info",
            id: `${runId}-info`,
            name: `subagent-delegate-${runId}-1`,
          }),
          JSON.stringify({
            type: "message",
            id: `${runId}-user`,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: { role: "user", content: [{ type: "text", text: `Task: ${name}\n\n---` }] },
          }),
        ].join("\n") + "\n",
      );
    }

    expect(listSubagentSessions(root, parentId)).toEqual([
      {
        nodeId: `external:${parentId}:run-a`,
        sessionId: "run-a-session",
        name: "检查内存",
        role: "delegate",
      },
      {
        nodeId: `external:${parentId}:run-b`,
        sessionId: "run-b-session",
        name: "检查磁盘",
        role: "delegate",
      },
    ]);
  });

  it("hides acceptance reports while preserving their message entry", () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-subagent-session-"));
    roots.push(root);
    const runDir = join(root, "run-hidden");
    mkdirSync(runDir, { recursive: true });
    const report = '```acceptance-report\n{"criteriaSatisfied":[]}\n```';
    writeFileSync(
      join(runDir, "session.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "hidden-session", cwd: root }),
        JSON.stringify({
          type: "message",
          id: "result",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `answer\n\n${report}` }],
          },
        }),
      ].join("\n") + "\n",
    );

    const snapshot = readSubagentSession(root, "hidden");
    const entry = snapshot?.entries.find((candidate) => candidate.id === "result");
    const content = (entry?.message as { content?: Array<{ text?: string }> })?.content?.[0]?.text;

    expect(entry).toBeDefined();
    expect(content).toBe("answer\n\n");
    expect(content).not.toContain("acceptance-report");
  });
});
