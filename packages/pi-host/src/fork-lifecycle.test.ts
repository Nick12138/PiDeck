import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareForkFile } from "./session-lifecycle.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createSessionFile() {
  const root = mkdtempSync(join(tmpdir(), "pideck-fork-"));
  roots.push(root);
  const cwd = resolve(join(root, "workspace"));
  mkdirSync(cwd, { recursive: true });
  const sessionDir = join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, "11111111-1111-4111-8111-111111111111.jsonl");
  const stamp = (offset: number) =>
    new Date(Date.parse("2026-01-01T00:00:00.000Z") + offset * 1000).toISOString();
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "11111111-1111-4111-8111-111111111111",
        timestamp: stamp(0),
        cwd,
      }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: stamp(1),
        message: { role: "user", content: [{ type: "text", text: "first ask" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: stamp(2),
        message: { role: "assistant", content: [{ type: "text", text: "the answer" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "u2",
        parentId: "a1",
        timestamp: stamp(3),
        message: { role: "user", content: "second ask" },
      }),
    ].join("\n") + "\n",
  );
  return { cwd, sessionPath };
}

describe("prepareForkFile", () => {
  it("creates a branched session file before the selected user message", () => {
    const { cwd, sessionPath } = createSessionFile();

    const prepared = prepareForkFile({
      sessionFile: sessionPath,
      canonicalCwd: cwd,
      entryId: "u2",
    });

    expect("error" in prepared).toBe(false);
    if ("error" in prepared) return;
    expect(prepared.selectedText).toBe("second ask");
    expect(prepared.forkedPath).not.toBe(sessionPath);
    expect(existsSync(prepared.forkedPath)).toBe(true);
    const forked = readFileSync(prepared.forkedPath, "utf8");
    expect(forked).toContain("first ask");
    expect(forked).toContain("the answer");
    expect(forked).not.toContain("second ask");
  });

  it("rejects non-user entries", () => {
    const { cwd, sessionPath } = createSessionFile();

    const prepared = prepareForkFile({
      sessionFile: sessionPath,
      canonicalCwd: cwd,
      entryId: "a1",
    });

    expect("error" in prepared && prepared.error.code).toBe("INVALID_REQUEST");
  });

  it("rejects forking before the first message", () => {
    const { cwd, sessionPath } = createSessionFile();

    const prepared = prepareForkFile({
      sessionFile: sessionPath,
      canonicalCwd: cwd,
      entryId: "u1",
    });

    expect("error" in prepared && prepared.error.code).toBe("INVALID_REQUEST");
  });

  it("rejects when the session file has not been persisted", () => {
    const { cwd } = createSessionFile();

    const prepared = prepareForkFile({
      sessionFile: join(cwd, "missing.jsonl"),
      canonicalCwd: cwd,
      entryId: "u2",
    });

    expect("error" in prepared && prepared.error.code).toBe("INVALID_REQUEST");
  });
});
