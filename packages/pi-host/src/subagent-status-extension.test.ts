import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { externalCompletedRuns, externalRunAgents } from "./subagent-status-extension.js";
import { listSubagentSessions } from "./subagent-session.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeSession(
  directory: string,
  filename: string,
  sessionId: string,
  runId: string,
  agent: string,
): void {
  const notification = `Background task completed: Workflow completed with 1 child run(s). Return: {\n  \"runId\": \"${runId}\",\n  \"agent\": \"${agent}\",\n  \"output\": \"done\"\n}`;
  writeFileSync(
    join(directory, filename),
    [
      JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: directory }),
      JSON.stringify({
        type: "custom_message",
        customType: "subagent-notify",
        content: notification,
      }),
    ].join("\n") + "\n",
  );
}

describe("externalCompletedRuns", () => {
  it("prefers the active named session when another session is newer", () => {
    const directory = mkdtempSync(join(tmpdir(), "pideck-subagents-"));
    roots.push(directory);
    writeSession(directory, "newer.jsonl", "newer-session", "newer-run", "reviewer");
    writeSession(directory, "active.jsonl", "active-session", "active-run", "delegate");

    const runs = externalCompletedRuns(directory, "active-session");

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: expect.stringContaining("active-run"),
      label: "delegate",
      role: "delegate",
      state: "complete",
    });
    expect(externalRunAgents(directory, "active-session")).toEqual(
      new Map([["active-run", "delegate"]]),
    );
  });

  it("preserves the role for a failed notification without an agent field", () => {
    const directory = mkdtempSync(join(tmpdir(), "pideck-subagents-"));
    roots.push(directory);
    const childDir = join(directory, "active-session", "failed-run", "run-0");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(directory, "active.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "active-session", cwd: directory }),
        JSON.stringify({
          type: "custom_message",
          customType: "subagent-notify",
          content: 'Background task failed: { "runId": "failed-run" }',
        }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(childDir, "session.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "failed-session", cwd: directory }),
        JSON.stringify({
          type: "session_info",
          id: "failed-info",
          name: "subagent-reviewer-failed-run-1",
        }),
      ].join("\n") + "\n",
    );

    expect(externalCompletedRuns(directory, "active-session")).toMatchObject([
      { state: "failed", role: "reviewer" },
    ]);
  });

  it("hides terminal runs that never produced a child session file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pideck-subagents-"));
    roots.push(directory);
    writeFileSync(
      join(directory, "active.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "active-session", cwd: directory }),
        // A launch-stage failure leaves only a notification; no session.jsonl
        // exists under the run directory (the child process never started).
        JSON.stringify({
          type: "custom_message",
          customType: "subagent-notify",
          content: 'Background task failed: { "runId": "orphan-run", "agent": "delegate" }',
        }),
        // A real completed run keeps a session file and must stay visible.
        JSON.stringify({
          type: "custom_message",
          customType: "subagent-notify",
          content:
            'Background task completed: { "runId": "real-run", "agent": "delegate", "output": "done" }',
        }),
      ].join("\n") + "\n",
    );
    const realChild = join(directory, "active-session", "real-run", "run-0");
    mkdirSync(realChild, { recursive: true });
    writeFileSync(
      join(realChild, "session.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "real-session", cwd: directory }),
        JSON.stringify({
          type: "session_info",
          id: "real-info",
          name: "subagent-delegate-real-run-1",
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          message: { role: "user", content: [{ type: "text", text: "ok" }] },
        }),
      ].join("\n") + "\n",
    );

    const runs = externalCompletedRuns(directory, "active-session");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: expect.stringContaining("real-run"), state: "complete" });
  });

  it("recovers the configured role from a live child session name", () => {
    const directory = mkdtempSync(join(tmpdir(), "pideck-subagents-"));
    roots.push(directory);
    const parent = join(directory, "active-session.jsonl");
    const childDir = join(directory, "active-session", "child-run", "run-0");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      parent,
      JSON.stringify({ type: "session", version: 3, id: "active-session", cwd: directory }) + "\n",
    );
    writeFileSync(
      join(childDir, "session.jsonl"),
      JSON.stringify({
        type: "session",
        version: 3,
        id: "child-session",
        name: "subagent-reviewer-child-run-1",
        cwd: directory,
      }) + "\n",
    );

    expect(listSubagentSessions(directory, "active-session")).toMatchObject([
      { nodeId: "external:active-session:child-run", role: "reviewer" },
    ]);
  });

  it("keeps the bounded newest-session fallback without a preferred session", () => {
    const directory = mkdtempSync(join(tmpdir(), "pideck-subagents-"));
    roots.push(directory);
    writeSession(directory, "session.jsonl", "session", "run", "worker");

    expect(externalCompletedRuns(directory)).toHaveLength(1);
  });
});
