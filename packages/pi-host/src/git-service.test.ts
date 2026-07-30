import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitService, parseGitStatusPorcelain } from "./git-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function createRepository(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "pideck-git-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "packages", "app");
  await mkdir(workspace, { recursive: true });
  git(root, "init");
  git(root, "config", "user.name", "PiDeck Test");
  git(root, "config", "user.email", "pideck@example.invalid");
  await writeFile(join(workspace, "tracked.txt"), "first\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  return { root, workspace };
}

describe("parseGitStatusPorcelain", () => {
  it("parses branch, ordinary, renamed, conflicted, and untracked records", () => {
    const oid = "a".repeat(40);
    const zero = "0".repeat(40);
    const output = Buffer.from(
      [
        `# branch.oid ${oid}`,
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -3",
        `1 .M N... 100644 100644 100644 ${oid} ${oid} src/app.ts`,
        `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 src/new name.ts`,
        "src/old name.ts",
        `u UU N... 100644 100644 100644 100644 ${oid} ${zero} ${oid} conflict.ts`,
        "? notes.txt",
      ].join("\0") + "\0",
    );

    const parsed = parseGitStatusPorcelain(output);
    expect(parsed).toMatchObject({
      branch: "main",
      detached: false,
      unborn: false,
      upstream: "origin/main",
      ahead: 2,
      behind: 3,
    });
    expect(parsed.files).toEqual([
      {
        path: "src/app.ts",
        staged: null,
        unstaged: "modified",
        conflict: false,
        submodule: false,
        pathSupported: true,
      },
      {
        path: "src/new name.ts",
        originalPath: "src/old name.ts",
        staged: "renamed",
        unstaged: null,
        conflict: false,
        submodule: false,
        pathSupported: true,
      },
      {
        path: "conflict.ts",
        staged: "conflicted",
        unstaged: "conflicted",
        conflict: true,
        submodule: false,
        pathSupported: true,
      },
      {
        path: "notes.txt",
        staged: null,
        unstaged: "untracked",
        conflict: false,
        submodule: false,
        pathSupported: true,
      },
    ]);
    expect(parsed.indexGeneration).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks non-UTF-8 paths read-only without losing the status record", () => {
    const output = Buffer.concat([Buffer.from("? bad-"), Buffer.from([0xff]), Buffer.from(".txt\0")]);
    const parsed = parseGitStatusPorcelain(output);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({ unstaged: "untracked", pathSupported: false });
    expect(parsed.warnings).toHaveLength(1);
  });
});

describe("GitService", () => {
  it("returns an expected empty state outside a repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-not-git-"));
    temporaryDirectories.push(root);
    await expect(new GitService().getStatus(root)).resolves.toEqual({
      state: "not_repository",
      revision: 1,
    });
  });

  it("reports a missing Git executable as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-no-git-"));
    temporaryDirectories.push(root);
    const status = await new GitService(join(root, "missing-git")).getStatus(root);
    expect(status.state).toBe("unavailable");
  });

  it("discovers the parent repository and preserves unstaged work across commit", async () => {
    const { root, workspace } = await createRepository();
    const service = new GitService();
    await writeFile(join(workspace, "tracked.txt"), "second\n", "utf8");
    await writeFile(join(workspace, "new.txt"), "new file\n", "utf8");

    const initial = await service.getStatus(workspace);
    expect(initial.state).toBe("ready");
    if (initial.state !== "ready") return;
    expect(initial.repositoryRoot).toBe(await realpath(root));
    expect(initial.workspaceIsRepositoryRoot).toBe(false);
    expect(initial.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "packages/app/tracked.txt", unstaged: "modified" }),
        expect.objectContaining({ path: "packages/app/new.txt", unstaged: "untracked" }),
      ]),
    );

    const trackedDiff = await service.getDiff(
      workspace,
      "packages/app/tracked.txt",
      "unstaged",
      initial.revision,
    );
    expect(trackedDiff.patch).toContain("+second");
    const newDiff = await service.getDiff(
      workspace,
      "packages/app/new.txt",
      "unstaged",
      initial.revision,
    );
    expect(newDiff.patch).toContain("+new file");

    const stagedResult = await service.stage(
      workspace,
      "packages/app/tracked.txt",
      initial.revision,
    );
    expect(stagedResult.applied).toBe(true);
    const staged = stagedResult.snapshot;
    expect(staged?.state).toBe("ready");
    if (!staged || staged.state !== "ready") return;
    expect(staged.files).toContainEqual(
      expect.objectContaining({
        path: "packages/app/tracked.txt",
        staged: "modified",
        unstaged: null,
      }),
    );

    await writeFile(join(workspace, "tracked.txt"), "third\n", "utf8");
    const both = await service.getStatus(workspace);
    expect(both.state).toBe("ready");
    if (both.state !== "ready") return;
    expect(both.files).toContainEqual(
      expect.objectContaining({
        path: "packages/app/tracked.txt",
        staged: "modified",
        unstaged: "modified",
      }),
    );

    const committed = await service.commit(workspace, "update tracked", both.indexGeneration);
    expect(committed.applied).toBe(true);
    expect(committed.commitSha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(git(root, "show", "HEAD:packages/app/tracked.txt")).toBe("second");
    expect(await service.getStatus(workspace)).toMatchObject({
      state: "ready",
      files: expect.arrayContaining([
        expect.objectContaining({
          path: "packages/app/tracked.txt",
          staged: null,
          unstaged: "modified",
        }),
      ]),
    });
  });

  it("unstages an indexed file without changing its working bytes", async () => {
    const { workspace } = await createRepository();
    const service = new GitService();
    await writeFile(join(workspace, "tracked.txt"), "changed\n", "utf8");
    const initial = await service.getStatus(workspace);
    if (initial.state !== "ready") throw new Error("expected ready status");
    const staged = await service.stage(
      workspace,
      "packages/app/tracked.txt",
      initial.revision,
    );
    if (!staged.snapshot || staged.snapshot.state !== "ready") throw new Error("expected status");
    const unstaged = await service.unstage(
      workspace,
      "packages/app/tracked.txt",
      staged.snapshot.revision,
    );
    expect(unstaged.snapshot).toMatchObject({
      state: "ready",
      files: [
        expect.objectContaining({
          path: "packages/app/tracked.txt",
          staged: null,
          unstaged: "modified",
        }),
      ],
    });
  });

  it("rejects commit when staged bytes change after review", async () => {
    const { workspace } = await createRepository();
    const service = new GitService();
    const path = "packages/app/tracked.txt";
    await writeFile(join(workspace, "tracked.txt"), "reviewed\n", "utf8");
    const initial = await service.getStatus(workspace);
    if (initial.state !== "ready") throw new Error("expected ready status");
    const reviewed = await service.stage(workspace, path, initial.revision);
    if (!reviewed.snapshot || reviewed.snapshot.state !== "ready") {
      throw new Error("expected staged status");
    }
    const expectedIndexGeneration = reviewed.snapshot.indexGeneration;

    await writeFile(join(workspace, "tracked.txt"), "changed after review\n", "utf8");
    const changed = await service.getStatus(workspace);
    if (changed.state !== "ready") throw new Error("expected changed status");
    const restaged = await service.stage(workspace, path, changed.revision);
    if (!restaged.snapshot || restaged.snapshot.state !== "ready") {
      throw new Error("expected restaged status");
    }
    expect(restaged.snapshot.indexGeneration).not.toBe(expectedIndexGeneration);
    await expect(
      service.commit(workspace, "must not commit", expectedIndexGeneration),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
  });
});
