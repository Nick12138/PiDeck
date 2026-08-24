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

  it("truncates the display name at the first comma or semicolon", () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-subagent-session-"));
    roots.push(root);
    const runDir = join(root, "run-trim");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "session.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "trim-session", cwd: root }),
        JSON.stringify({
          type: "message",
          id: "u1",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "检查磁盘空间，清理缓存；然后报告结果。别的内容不应该出现",
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );

    const snapshot = readSubagentSession(root, "trim");

    expect(snapshot?.name).toBe("检查磁盘空间");
  });
});

describe("forked subagent transcripts", () => {
  it("discovers fork-context workers by their encoded run id instead of the forks directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-subagent-session-"));
    roots.push(root);
    const parentId = "parent-session";
    const parentFile = join(root, "parent-file.jsonl");
    writeFileSync(
      parentFile,
      JSON.stringify({ type: "session", version: 3, id: parentId, cwd: root }) + "\n",
    );
    const forksDir = join(root, "parent-file", "forks");
    mkdirSync(forksDir, { recursive: true });
    const runId = "d03f2971-8aa8-4da8-977f-8ac6f152f075";
    writeFileSync(
      join(forksDir, "fork-session.jsonl"),
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "fork-session",
          parentSession: parentFile,
          cwd: root,
        }),
        JSON.stringify({ type: "model_change", id: "m1", provider: "1", modelId: "x" }),
        JSON.stringify({ type: "session_info", id: "parent-info", name: "🌐 检查磁盘" }),
        JSON.stringify({
          type: "message",
          id: "parent-msg",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "检查磁盘" }] },
        }),
        JSON.stringify({ type: "session_info", id: "child-info", name: `subagent-worker-${runId}-1` }),
        JSON.stringify({
          type: "message",
          id: "child-msg",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: `Task: [Read from: C:\\context.md]\n\nYou are a delegated subagent.\n\nTask:\n检查磁盘空间\n\n---`,
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );

    const sessions = listSubagentSessions(root, parentId);

    expect(sessions).toEqual([
      {
        nodeId: `external:${parentId}:${runId}`,
        sessionId: "fork-session",
        name: "检查磁盘空间",
        role: "worker",
      },
    ]);
    const snapshot = readSubagentSession(root, sessions[0]!.nodeId);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.entries.map((entry) => entry.id)).toEqual(["child-info", "child-msg"]);
    expect(snapshot?.entries.find((entry) => entry.id === "parent-msg")).toBeUndefined();
  });

  it("resolves the state of a foreground run from the parent tool-result mission", () => {
    const root = mkdtempSync(join(tmpdir(), "pideck-subagent-session-"));
    roots.push(root);
    const parentId = "parent-session";
    const parentFile = join(root, "parent-file.jsonl");
    const runId = "d03f2971-8aa8-4da8-977f-8ac6f152f075";
    writeFileSync(
      parentFile,
      [
        JSON.stringify({ type: "session", version: 3, id: parentId, cwd: root }),
        JSON.stringify({
          type: "message",
          id: "tool-result",
          message: {
            role: "toolResult",
            toolName: "subagent",
            content: [],
            details: {
              runId,
              mission: { status: "completed", runs: [{ runId, status: "completed" }] },
            },
          },
        }),
      ].join("\n") + "\n",
    );
    const childDir = join(root, "parent-file", runId, "run-0");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(childDir, "session.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "child-session", cwd: root }),
        JSON.stringify({
          type: "message",
          id: "m1",
          message: { role: "user", content: [{ type: "text", text: "Task: 干活" }] },
        }),
      ].join("\n") + "\n",
    );

    const snapshot = readSubagentSession(root, `external:${parentId}:${runId}`);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.state).toBe("complete");
  });
});
