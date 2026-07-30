import { createHostError, type GitStatusSnapshot, type HostError } from "@pideck/protocol";
import { GitService, GitServiceError } from "./git-service.js";
import { withRegisteredGraphMutation } from "./registered-graph-mutation.js";
import type { MethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

function hostError(error: unknown): HostError {
  if (error instanceof GitServiceError) {
    return createHostError(error.code, error.message, { retryable: error.retryable });
  }
  return createHostError(
    "GIT_OPERATION_FAILED",
    error instanceof Error ? error.message : String(error),
  );
}

function workspace(factory: WorkspaceGraphFactory): string | null {
  return factory.getGraph()?.canonicalCwd ?? null;
}

export function createGitHandlers(
  factory: WorkspaceGraphFactory,
  service: GitService,
): Partial<Record<string, MethodHandler>> {
  const emitSnapshot = (snapshot: GitStatusSnapshot) => {
    factory.getServer()?.emit("git.changed", { snapshot });
  };

  return {
    "git.getStatus": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      try {
        const result = await service.getStatus(root);
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        return staleAfter ? { error: staleAfter } : { result };
      } catch (error) {
        return { error: hostError(error) };
      }
    },

    "git.setWatching": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      const server = factory.getServer();
      if (!root || !server) {
        return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      }
      const params = ctx.params as { enabled: boolean };
      const identity = server.getIdentity();
      try {
        const result = await service.setWatching(params.enabled, root, (snapshot) => {
          const current = factory.getGraph();
          const currentServer = factory.getServer();
          if (
            !current ||
            !currentServer ||
            current.workspaceId !== identity.workspaceId ||
            current.revision !== identity.workspaceRevision ||
            current.canonicalCwd !== root
          ) {
            return;
          }
          currentServer.emitForIdentity(identity, "git.changed", { snapshot });
        });
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        if (staleAfter) {
          service.stopWatching();
          return { error: staleAfter };
        }
        return { result };
      } catch (error) {
        service.stopWatching();
        return { error: hostError(error) };
      }
    },

    "git.getDiff": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      const params = ctx.params as {
        path: string;
        area: "staged" | "unstaged";
        expectedRevision: number;
      };
      try {
        const result = await service.getDiff(
          root,
          params.path,
          params.area,
          params.expectedRevision,
        );
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        return staleAfter ? { error: staleAfter } : { result };
      } catch (error) {
        return { error: hostError(error) };
      }
    },

    "git.stage": async (ctx) =>
      mutateGit(factory, ctx, (root, signal) => {
        const params = ctx.params as { path: string; expectedRevision: number };
        return service.stage(root, params.path, params.expectedRevision, signal);
      }, emitSnapshot),

    "git.unstage": async (ctx) =>
      mutateGit(factory, ctx, (root, signal) => {
        const params = ctx.params as { path: string; expectedRevision: number };
        return service.unstage(root, params.path, params.expectedRevision, signal);
      }, emitSnapshot),

    "git.commit": async (ctx) =>
      mutateGit(factory, ctx, (root, signal) => {
        const params = ctx.params as { message: string; expectedIndexGeneration: string };
        return service.commit(root, params.message, params.expectedIndexGeneration, signal);
      }, emitSnapshot),
  };
}

async function mutateGit(
  factory: WorkspaceGraphFactory,
  ctx: Parameters<MethodHandler>[0],
  mutate: (
    root: string,
    signal: AbortSignal,
  ) => Promise<{ applied: true; snapshot?: GitStatusSnapshot }>,
  emitSnapshot: (snapshot: GitStatusSnapshot) => void,
) {
  const server = factory.getServer();
  if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
  const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
  if (stale) return { error: stale };

  try {
    return await withRegisteredGraphMutation({
      server,
      operationKind: "git.mutation",
      requestId: ctx.id,
      run: async ({ signal }) => {
        const staleAfterLock = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        if (staleAfterLock) return { error: staleAfterLock };
        const root = workspace(factory);
        if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
        try {
          const result = await mutate(root, signal);
          if (result.snapshot) emitSnapshot(result.snapshot);
          return { result };
        } catch (error) {
          return { error: hostError(error) };
        }
      },
    });
  } catch (error) {
    return { error: hostError(error) };
  }
}
