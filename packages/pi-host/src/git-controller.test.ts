import { describe, expect, it, vi } from "vitest";
import { createHostError, type GitStatusSnapshot, type HostIdentity } from "@pideck/protocol";
import { GraphOperationRegistry } from "./operation-lifecycle.js";
import { TryMutex } from "./locks.js";
import type { HandlerContext } from "./server.js";
import { createGitHandlers } from "./git-controller.js";
import type { GitService } from "./git-service.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

const identity: HostIdentity = {
  hostInstanceId: "00000000-0000-4000-8000-000000000101",
  workspaceId: "00000000-0000-4000-8000-000000000201",
  workspaceRevision: 3,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 0,
};

const ready: Extract<GitStatusSnapshot, { state: "ready" }> = {
  state: "ready",
  revision: 4,
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
  files: [{
    path: "src/app.ts",
    staged: null,
    unstaged: "modified",
    conflict: false,
    submodule: false,
    pathSupported: true,
  }],
  warnings: [],
};

function fixture() {
  const graph = {
    canonicalCwd: "/repo/apps/desktop",
    workspaceId: identity.workspaceId,
    revision: identity.workspaceRevision,
  };
  const server = {
    graphOperations: new GraphOperationRegistry(),
    serviceGraphLock: new TryMutex(),
    getIdentity: () => ({ ...identity }),
    emit: vi.fn(),
    emitForIdentity: vi.fn(),
  };
  const factory = {
    getGraph: () => graph,
    getServer: () => server,
    checkIdentity: vi.fn(() => null),
  } as unknown as WorkspaceGraphFactory;
  const service = {
    getStatus: vi.fn(async () => ready),
    setWatching: vi.fn(async (_enabled, _workspace, emit) => {
      emit(ready);
      return { watching: true, snapshot: ready };
    }),
    stopWatching: vi.fn(),
    getDiff: vi.fn(),
    listBranches: vi.fn(async () => ({
      statusRevision: ready.revision,
      current: "main",
      detached: false,
      branches: [],
      truncated: false,
    })),
    listHistory: vi.fn(async () => ({ commits: [], nextCursor: null })),
    getCommitDiff: vi.fn(),
    mutateHunk: vi.fn(async () => ({ applied: true as const, snapshot: ready })),
    stage: vi.fn(async () => ({ applied: true as const, snapshot: ready })),
    stageAll: vi.fn(async () => ({ applied: true as const, snapshot: ready })),
    unstage: vi.fn(),
    unstageAll: vi.fn(),
    discard: vi.fn(),
    commit: vi.fn(),
    createBranch: vi.fn(async () => ({ applied: true as const, snapshot: ready })),
    switchBranch: vi.fn(async () => ({ applied: true as const, snapshot: ready })),
  } as unknown as GitService;
  return { factory, graph, server, service };
}

function context(method: string, params: unknown): HandlerContext {
  return {
    id: "00000000-0000-4000-8000-000000000301",
    method,
    params,
    context: {
      expectedHostInstanceId: identity.hostInstanceId,
      expectedWorkspaceId: identity.workspaceId,
      expectedWorkspaceRevision: identity.workspaceRevision,
    },
  } as unknown as HandlerContext;
}

describe("Git controller", () => {
  it("reads status for the active canonical workspace", async () => {
    const state = fixture();
    const result = await createGitHandlers(state.factory, state.service)["git.getStatus"]!(
      context("git.getStatus", null),
    );
    expect(state.service.getStatus).toHaveBeenCalledWith("/repo/apps/desktop");
    expect(result).toEqual({ result: ready });
  });

  it("emits a full status snapshot after a locked stage mutation", async () => {
    const state = fixture();
    const result = await createGitHandlers(state.factory, state.service)["git.stage"]!(
      context("git.stage", { path: "src/app.ts", expectedRevision: 4 }),
    );
    expect(state.service.stage).toHaveBeenCalledWith(
      "/repo/apps/desktop",
      "src/app.ts",
      4,
      expect.any(AbortSignal),
    );
    expect(state.server.emit).toHaveBeenCalledWith("git.changed", { snapshot: ready });
    expect(result).toEqual({ result: { applied: true, snapshot: ready } });
    expect(state.server.serviceGraphLock.getOwner()).toBeNull();
    expect(state.server.graphOperations.getActive()).toBeNull();
  });

  it("returns SERVICE_GRAPH_BUSY without invoking Git when another mutation is active", async () => {
    const state = fixture();
    const active = state.server.graphOperations.begin({
      operationKind: "workspace.setCurrent",
      requestId: "00000000-0000-4000-8000-000000000401",
      operationId: "00000000-0000-4000-8000-000000000402",
    });
    const result = await createGitHandlers(state.factory, state.service)["git.stage"]!(
      context("git.stage", { path: "src/app.ts", expectedRevision: 4 }),
    );
    expect(result).toMatchObject({ error: { code: "SERVICE_GRAPH_BUSY" } });
    expect(state.service.stage).not.toHaveBeenCalled();
    active?.finish();
  });

  it("routes batch and discard mutations through the locked Git service", async () => {
    const state = fixture();
    const handlers = createGitHandlers(state.factory, state.service);

    await handlers["git.stageAll"]!(context("git.stageAll", { expectedRevision: 4 }));
    expect(state.service.stageAll).toHaveBeenCalledWith(
      "/repo/apps/desktop",
      4,
      expect.any(AbortSignal),
    );

    vi.mocked(state.service.discard).mockResolvedValueOnce({ applied: true, snapshot: ready });
    await handlers["git.discard"]!(
      context("git.discard", { path: "src/app.ts", expectedRevision: 4 }),
    );
    expect(state.service.discard).toHaveBeenCalledWith(
      "/repo/apps/desktop",
      "src/app.ts",
      4,
      expect.any(AbortSignal),
    );
    expect(state.server.emit).toHaveBeenCalledTimes(2);
  });

  it("routes hunk and branch mutations through the lock and emits refreshed status", async () => {
    const state = fixture();
    const handlers = createGitHandlers(state.factory, state.service);
    await handlers["git.mutateHunk"]!(context("git.mutateHunk", {
      path: "src/app.ts",
      area: "unstaged",
      hunkId: "a".repeat(64),
      operation: "stage",
      expectedRevision: 4,
      expectedContentGeneration: "b".repeat(64),
    }));
    expect(state.service.mutateHunk).toHaveBeenCalledWith(
      "/repo/apps/desktop",
      "src/app.ts",
      "unstaged",
      "a".repeat(64),
      "stage",
      4,
      "b".repeat(64),
      expect.any(AbortSignal),
    );

    await handlers["git.createBranch"]!(context("git.createBranch", {
      name: "feature/git",
      expectedRevision: 4,
    }));
    await handlers["git.switchBranch"]!(context("git.switchBranch", {
      name: "main",
      expectedRevision: 4,
    }));
    expect(state.service.createBranch).toHaveBeenCalledWith(
      "/repo/apps/desktop", "feature/git", 4, expect.any(AbortSignal),
    );
    expect(state.service.switchBranch).toHaveBeenCalledWith(
      "/repo/apps/desktop", "main", 4, expect.any(AbortSignal),
    );
    expect(state.server.emit).toHaveBeenCalledTimes(3);
  });

  it("routes branch, history, and commit diff reads without taking the mutation lock", async () => {
    const state = fixture();
    const handlers = createGitHandlers(state.factory, state.service);
    await handlers["git.listBranches"]!(context("git.listBranches", null));
    await handlers["git.listHistory"]!(context("git.listHistory", { limit: 25, cursor: "a".repeat(40) }));
    await handlers["git.getCommitDiff"]!(context("git.getCommitDiff", { commitSha: "b".repeat(40) }));
    expect(state.service.listBranches).toHaveBeenCalledWith("/repo/apps/desktop");
    expect(state.service.listHistory).toHaveBeenCalledWith("/repo/apps/desktop", 25, "a".repeat(40));
    expect(state.service.getCommitDiff).toHaveBeenCalledWith("/repo/apps/desktop", "b".repeat(40));
    expect(state.server.serviceGraphLock.getOwner()).toBeNull();
  });

  it("identity-checks watch events and stops a stale subscription", async () => {
    const state = fixture();
    const handlers = createGitHandlers(state.factory, state.service);
    const result = await handlers["git.setWatching"]!(
      context("git.setWatching", { enabled: true }),
    );
    expect(result).toEqual({ result: { watching: true, snapshot: ready } });
    expect(state.server.emitForIdentity).toHaveBeenCalledWith(identity, "git.changed", { snapshot: ready });

    state.server.emitForIdentity.mockClear();
    state.graph.revision += 1;
    const emit = vi.mocked(state.service.setWatching).mock.calls[0]![2];
    emit(ready);
    expect(state.server.emitForIdentity).not.toHaveBeenCalled();

    vi.mocked(state.factory.checkIdentity).mockReturnValueOnce(
      createHostError("STALE_REVISION", "stale"),
    );
    const stale = await handlers["git.setWatching"]!(
      context("git.setWatching", { enabled: false }),
    );
    expect(stale).toMatchObject({ error: { code: "STALE_REVISION" } });
  });
});
