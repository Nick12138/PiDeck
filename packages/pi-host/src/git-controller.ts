import { createHostError, type GitStatusSnapshot, type HostError } from "@pideck/protocol";
import { completeSimple, type Context } from "@earendil-works/pi-ai/compat";
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

    "git.listBranches": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      try {
        const result = await service.listBranches(root);
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        return staleAfter ? { error: staleAfter } : { result };
      } catch (error) {
        return { error: hostError(error) };
      }
    },

    "git.listHistory": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      const params = ctx.params as { limit: number; cursor?: string };
      try {
        const result = await service.listHistory(root, params.limit, params.cursor);
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        return staleAfter ? { error: staleAfter } : { result };
      } catch (error) {
        return { error: hostError(error) };
      }
    },

    "git.getCommitDiff": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      const params = ctx.params as { commitSha: string };
      try {
        const result = await service.getCommitDiff(root, params.commitSha);
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        return staleAfter ? { error: staleAfter } : { result };
      } catch (error) {
        return { error: hostError(error) };
      }
    },

    "git.mutateHunk": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as {
            path: string;
            area: "staged" | "unstaged";
            hunkId: string;
            operation: "stage" | "unstage" | "discard";
            expectedRevision: number;
            expectedContentGeneration: string;
          };
          return service.mutateHunk(
            root,
            params.path,
            params.area,
            params.hunkId,
            params.operation,
            params.expectedRevision,
            params.expectedContentGeneration,
            signal,
          );
        },
        emitSnapshot,
      ),

    "git.stage": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { path: string; expectedRevision: number };
          return service.stage(root, params.path, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),

    "git.stageAll": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { expectedRevision: number };
          return service.stageAll(root, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),

    "git.unstage": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { path: string; expectedRevision: number };
          return service.unstage(root, params.path, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),

    "git.unstageAll": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { expectedRevision: number };
          return service.unstageAll(root, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),

    "git.discard": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { path: string; expectedRevision: number };
          return service.discard(root, params.path, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),

    "git.commit": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { message: string; expectedIndexGeneration: string };
          return service.commit(root, params.message, params.expectedIndexGeneration, signal);
        },
        emitSnapshot,
      ),

    "git.generateCommitMessage": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      const params = ctx.params as { expectedIndexGeneration: string };
      const model = factory.getGraph()?.agentSession?.model;
      if (!model) {
        return {
          error: createHostError(
            "AGENT_NOT_READY",
            "No active session model to generate a message",
          ),
        };
      }
      try {
        const { patch, truncated } = await service.getStagedPatch(
          root,
          params.expectedIndexGeneration,
        );
        if (!patch.trim()) {
          return {
            error: createHostError("INVALID_REQUEST", "No staged changes to summarize"),
          };
        }
        const auth = await factory.deps.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          return { error: createHostError("AUTH_REQUIRED", auth.error) };
        }
        const context: Context = {
          systemPrompt: [
            "You write Git commit messages for a desktop coding agent.",
            "Write in Simplified Chinese.",
            "Use Conventional Commits: <type>(<scope>): <subject>, then a blank line and concise bullet points for the key changes.",
            "Keep the subject under 50 characters and imperative.",
            "Do not use markdown code fences, quotes, labels, or ending punctuation.",
            "Base the message only on the provided staged diff.",
          ].join(" "),
          messages: [
            {
              role: "user",
              content: [
                `Staged diff:\n\`\`\`diff\n${patch.slice(0, 20_000)}\n\`\`\``,
                truncated ? "Note: the diff was truncated, so the message may be incomplete." : "",
              ]
                .filter(Boolean)
                .join("\n\n"),
              timestamp: Date.now(),
            },
          ],
        };
        const response = await completeSimple(model, context, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          maxTokens: 300,
          reasoning: "minimal",
          timeoutMs: 30_000,
          maxRetries: 0,
        });
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          return {
            error: createHostError(
              "INTERNAL_ERROR",
              response.errorMessage ?? `Commit message generation ${response.stopReason}`,
            ),
          };
        }
        const message = response.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (!message) {
          return {
            error: createHostError("INTERNAL_ERROR", "The model returned an empty commit message"),
          };
        }
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        if (staleAfter) return { error: staleAfter };
        return { result: { message, ...(truncated ? { truncated: true } : {}) } };
      } catch (error) {
        return { error: hostError(error) };
      }
    },

    "git.push": async (ctx) =>
      mutateGit(factory, ctx, (root, signal) => service.push(root, signal), emitSnapshot),

    "git.pull": async (ctx) =>
      mutateGit(factory, ctx, (root, signal) => service.pull(root, signal), emitSnapshot),

    "git.createBranch": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { name: string; expectedRevision: number };
          return service.createBranch(root, params.name, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),

    "git.switchBranch": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { name: string; expectedRevision: number };
          return service.switchBranch(root, params.name, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),
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
