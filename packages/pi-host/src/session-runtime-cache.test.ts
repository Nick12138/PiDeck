import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureActiveSessionState,
  commitActiveSessionState,
  IDLE_SESSION_CACHE_TTL_MS,
  MAX_IDLE_SESSION_CACHE,
  SESSION_DISPOSAL_STEP_TIMEOUT_MS,
  SessionRuntimeCache,
  type ActiveSessionState,
} from "./session-runtime-cache.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";

function activeSlots(seed: string): ActiveSessionState {
  return {
    sessionManager: { seed } as unknown as ActiveSessionState["sessionManager"],
    agentSession: { seed } as unknown as ActiveSessionState["agentSession"],
    extensionsResult: { seed },
    resourceLoader: { seed } as unknown as ActiveSessionState["resourceLoader"],
    toolRevision: seed === "next" ? 9 : 3,
    sessionSnapshot: { sessionId: seed } as ActiveSessionState["sessionSnapshot"],
    extensionUiActivate: vi.fn(),
    extensionUiCleanup: vi.fn(),
    extensionUiUpdateIdentity: vi.fn(),
    extensionUiReplayState: vi.fn(),
    unsubscribeAgent: vi.fn(),
    sessionId: seed,
    sessionRevision: seed === "next" ? 7 : 2,
  };
}

function graphFrom(state: ActiveSessionState): WorkspaceGraph {
  return {
    sessionManager: state.sessionManager,
    agentSession: state.agentSession,
    extensionsResult: state.extensionsResult,
    resourceLoader: state.resourceLoader,
    toolRevision: state.toolRevision,
    sessionSnapshot: state.sessionSnapshot,
    extensionUiActivate: state.extensionUiActivate,
    extensionUiCleanup: state.extensionUiCleanup,
    extensionUiUpdateIdentity: state.extensionUiUpdateIdentity,
    extensionUiReplayState: state.extensionUiReplayState,
    unsubscribeAgent: state.unsubscribeAgent,
  } as WorkspaceGraph;
}

function disposalCache(): SessionRuntimeCache {
  return new SessionRuntimeCache({
    getGraph: () => null,
    getServer: () => null,
    getCurrentRunId: () => null,
    sessionPathsEqual: () => false,
  });
}

function disposalSession(options: {
  emit?: () => Promise<void>;
  abort?: () => Promise<void>;
} = {}) {
  const emit = vi.fn(options.emit ?? (async () => undefined));
  const abort = vi.fn(options.abort ?? (async () => undefined));
  const dispose = vi.fn();
  const session = {
    isIdle: false,
    extensionRunner: {
      hasHandlers: vi.fn(() => true),
      emit,
    },
    abort,
    dispose,
  } as unknown as AgentSession;
  return { session, emit, abort, dispose };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session disposal bounds", () => {
  it("continues through abort and dispose when session_shutdown never settles", async () => {
    vi.useFakeTimers();
    const cache = disposalCache();
    const { session, emit, abort, dispose } = disposalSession({
      emit: () => new Promise<void>(() => undefined),
    });
    let settled = false;

    void cache.disposeAgentSessionOnly(session).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(emit).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(SESSION_DISPOSAL_STEP_TIMEOUT_MS);

    expect(settled).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("continues through dispose and handles a late abort rejection", async () => {
    vi.useFakeTimers();
    let rejectAbort: ((reason?: unknown) => void) | undefined;
    const abortPromise = new Promise<void>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const cache = disposalCache();
    const { session, abort, dispose } = disposalSession({
      abort: () => abortPromise,
    });
    let settled = false;

    void cache.disposeAgentSessionOnly(session).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(SESSION_DISPOSAL_STEP_TIMEOUT_MS);

    expect(settled).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();

    rejectAbort?.(new Error("late abort failure"));
    await Promise.resolve();
  });
});

describe("idle Session cache", () => {
  it("retains an idle Session without treating it as a busy background runtime", () => {
    const cache = disposalCache();
    const state = activeSlots("idle");
    Reflect.set(state.agentSession!, "isIdle", true);
    const graph = {
      ...graphFrom(state),
      backgroundSessions: new Map(),
    } as unknown as WorkspaceGraph;

    const runtime = cache.retainSessionRuntime(graph, state);

    expect(runtime?.agentSession).toBe(state.agentSession);
    expect(graph.backgroundSessions.size).toBe(0);
    expect(graph.idleSessionCache?.get("idle")).toBe(runtime);
  });

  it("keeps the five most recently active idle Sessions and evicts the oldest runtime", () => {
    const cache = disposalCache();
    const graph = { backgroundSessions: new Map() } as unknown as WorkspaceGraph;
    const states = ["A", "B", "C", "D", "E"].map((sessionId) => {
      const state = activeSlots(sessionId);
      Reflect.set(state.agentSession!, "isIdle", true);
      cache.retainSessionRuntime(graph, state);
      return state;
    });

    cache.touchIdleSession(graph, "F");

    expect(MAX_IDLE_SESSION_CACHE).toBe(5);
    expect([...graph.idleSessionRecency?.keys() ?? []]).toEqual(["B", "C", "D", "E", "F"]);
    expect([...graph.idleSessionCache?.keys() ?? []]).toEqual(["B", "C", "D", "E"]);
    expect(graph.idleSessionCache?.has("A")).toBe(false);
    expect(states[0]!.agentSession).not.toBeNull();
  });

  it("expires an untouched cached Session after the configured idle timeout", async () => {
    vi.useFakeTimers();
    const cache = disposalCache();
    const state = activeSlots("idle");
    Reflect.set(state.agentSession!, "isIdle", true);
    const graph = { backgroundSessions: new Map() } as unknown as WorkspaceGraph;

    cache.retainSessionRuntime(graph, state);
    await vi.advanceTimersByTimeAsync(IDLE_SESSION_CACHE_TTL_MS);

    expect(graph.idleSessionCache?.has("idle")).toBe(false);
    expect(graph.idleSessionRecency?.has("idle")).toBe(false);
  });

  it("removes a running Session from the idle queue", () => {
    const cache = disposalCache();
    const state = activeSlots("running");
    Reflect.set(state.agentSession!, "isIdle", true);
    const graph = {
      ...graphFrom(state),
      backgroundSessions: new Map(),
    } as unknown as WorkspaceGraph;

    cache.touchIdleSession(graph, "running");
    Reflect.set(state.agentSession!, "isIdle", false);
    cache.touchIdleSession(graph, "running");

    expect(graph.idleSessionRecency?.has("running")).toBe(false);
  });
});
describe("active Session state", () => {
  it("captures all Session graph slots and both identity fields", () => {
    const state = activeSlots("current");
    const captured = captureActiveSessionState(graphFrom(state), {
      sessionId: state.sessionId,
      sessionRevision: state.sessionRevision,
    });

    expect(captured).toEqual(state);
  });

  it("commits only Session graph slots and identity", () => {
    const current = activeSlots("current");
    const next = activeSlots("next");
    const graph = {
      ...graphFrom(current),
      workspaceId: "workspace-stable",
      revision: 11,
      packageSnapshot: { revision: 13 },
      backgroundSessions: new Map([["background", {}]]),
    } as unknown as WorkspaceGraph;
    const identity = {
      sessionId: current.sessionId,
      sessionRevision: current.sessionRevision,
      workspaceRevision: 11,
      packageRevision: 13,
    };

    commitActiveSessionState(graph, identity, next);

    expect(captureActiveSessionState(graph, identity)).toEqual(next);
    expect(graph).toMatchObject({
      workspaceId: "workspace-stable",
      revision: 11,
      packageSnapshot: { revision: 13 },
    });
    expect(graph.backgroundSessions.has("background")).toBe(true);
    expect(identity).toMatchObject({ workspaceRevision: 11, packageRevision: 13 });
  });
});
