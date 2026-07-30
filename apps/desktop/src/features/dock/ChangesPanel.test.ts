import { describe, expect, it } from "vitest";
import type { GitStatusSnapshot } from "@pideck/protocol";
import { buildGitListRows, gitChangeLetter, parseUnifiedDiffLines } from "./ChangesPanel";

describe("ChangesPanel helpers", () => {
  it("shows the same file in unstaged and staged groups", () => {
    const status: Extract<GitStatusSnapshot, { state: "ready" }> = {
      state: "ready",
      revision: 1,
      repositoryRoot: "/repo",
      workspaceIsRepositoryRoot: true,
      branch: "main",
      detached: false,
      unborn: false,
      headSha: "a".repeat(40),
      upstream: null,
      ahead: 0,
      behind: 0,
      indexGeneration: "b".repeat(64),
      warnings: [],
      files: [{
        path: "src/app.ts",
        staged: "modified",
        unstaged: "modified",
        conflict: false,
        submodule: false,
        pathSupported: true,
      }],
    };
    const rows = buildGitListRows(status);
    expect(rows.filter((row) => row.kind === "file")).toEqual([
      expect.objectContaining({ area: "unstaged" }),
      expect.objectContaining({ area: "staged" }),
    ]);
  });

  it("tracks old and new line numbers across hunks", () => {
    const lines = parseUnifiedDiffLines("@@ -2,2 +2,2 @@\n old\n-removed\n+added\n\\ No newline at end of file");
    expect(lines).toEqual([
      expect.objectContaining({ kind: "hunk", oldLine: null, newLine: null }),
      expect.objectContaining({ kind: "context", oldLine: 2, newLine: 2 }),
      expect.objectContaining({ kind: "deletion", oldLine: 3, newLine: null }),
      expect.objectContaining({ kind: "addition", oldLine: null, newLine: 3 }),
      expect.objectContaining({ kind: "meta", oldLine: null, newLine: null }),
    ]);
  });

  it("uses compact, stable status letters", () => {
    expect(gitChangeLetter("untracked")).toBe("U");
    expect(gitChangeLetter("conflicted")).toBe("!");
  });
});
