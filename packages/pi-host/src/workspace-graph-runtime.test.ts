import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { HostEventName, HostIdentity } from "@pideck/protocol";
import type { PiHostServer } from "./server.js";
import { TryMutex } from "./locks.js";
import { GraphOperationRegistry } from "./operation-lifecycle.js";
import { ExtensionProviderOwnership } from "./extension-provider-ownership.js";
import {
  WorkspaceGraphFactory,
  type BackgroundSessionRuntime,
  type GraphFactoryDeps,
  type WorkspaceGraph,
} from "./workspace-graph-factory.js";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const BACKGROUND_SESSION_ID = "44444444-4444-4444-8444-444444444444";

function workspaceProviderConfig(baseUrl: string, apiKey: string) {
  return {
    baseUrl,
    apiKey,
    api: "openai-completions" as const,
    models: [
      {
        id: "workspace-model",
        name: "Workspace Model",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
  };
}

function fakeSession(isIdle: boolean, sessionId = "session"): AgentSession {
  return {
    isIdle,
    isCompacting: false,
    isRetrying: false,
    sessionId,
    sessionFile: `C:/sessions/${sessionId}.jsonl`,
    sessionName: sessionId,
    model: undefined,
    messages: [],
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getAllTools: () => [],
    getActiveToolNames: () => [],
    getAvailableThinkingLevels: () => ["off"],
    subscribe: vi.fn(() => vi.fn()),
    bindExtensions: vi.fn(async () => {}),
    extensionRunner: {
      hasHandlers: vi.fn(() => true),
      emit: vi.fn(async () => undefined),
    },
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  } as unknown as AgentSession;
}

function fakeSessionSnapshot(
  sessionId: string,
  revision: number,
  isIdle: boolean,
): BackgroundSessionRuntime["sessionSnapshot"] {
  return {
    sessionId,
    sessionPath: `C:/sessions/${sessionId}.jsonl`,
    cwd: "C:/workspace",
    revision,
    isStreaming: !isIdle,
    isIdle,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId,
      sessionRevision: revision,
      tools: [],
      active: [],
    },
  } as BackgroundSessionRuntime["sessionSnapshot"];
}

function fakeWorkspaceGraph(
  canonicalCwd: string,
  workspaceId: string,
  session: AgentSession,
): WorkspaceGraph {
  const sessionId = session.sessionId;
  return {
    workspaceId,
    cwd: canonicalCwd,
    canonicalCwd,
    revision: 1,
    servicesReady: true,
    settingsManager: {
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    },
    packageManager: {
      listConfiguredPackages: () => [],
      resolve: async () => ({ extensions: [], skills: [], prompts: [], themes: [] }),
    },
    resourceLoader: null,
    sessionManager: { getSessionId: () => sessionId },
    agentSession: session,
    extensionsResult: null,
    packageSnapshot: null,
    sessionSnapshot: fakeSessionSnapshot(sessionId, 1, true),
    toolRevision: 1,
    resourceIdMap: new Map(),
    unsubscribeAgent: vi.fn(),
    extensionUiActivate: null,
    extensionUiCleanup: vi.fn(),
    extensionUiUpdateIdentity: null,
    resourceReloadRequired: false,
    backgroundSessions: new Map(),
    retainedSessions: new Map(),
  } as unknown as WorkspaceGraph;
}

describe("WorkspaceGraphFactory multi-Session routing", () => {
  it("shuts extensions down before disposing a Session exactly once", async () => {
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    const session = fakeSession(true);

    await factory.disposeAgentSessionOnly(session);
    await factory.disposeAgentSessionOnly(session);

    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(session.extensionRunner.emit).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(session.dispose).mock.invocationCallOrder[0]!);
  });

  it("uses independent operation locks for different AgentSession instances", () => {
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    const first = fakeSession(false);
    const second = fakeSession(false);

    expect(factory.getSessionOperationLock(first).tryAcquire("first")).toBe(true);
    expect(factory.getSessionOperationLock(second).tryAcquire("second")).toBe(true);
    expect(factory.getSessionOperationLock(first).tryAcquire("again")).toBe(false);
  });

  it("reports an idle SDK session as busy while a Host operation owns it", () => {
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    const session = fakeSession(true, ACTIVE_SESSION_ID);
    const graph = fakeWorkspaceGraph("C:/workspace", WORKSPACE_ID, session);
    Reflect.set(factory, "graph", graph);

    expect(factory.getSessionOperationLock(session).tryAcquire("in-flight-prompt")).toBe(
      true,
    );

    expect(factory.hasBusySessions()).toBe(true);
    factory.getSessionOperationLock(session).release("in-flight-prompt");
  });

  it("retains a lock-held idle session as a busy background runtime", () => {
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    const session = fakeSession(true, ACTIVE_SESSION_ID);
    const graph = fakeWorkspaceGraph("C:/workspace", WORKSPACE_ID, session);
    const unsubscribe = vi.fn();
    const extensionUiCleanup = vi.fn();
    expect(factory.getSessionOperationLock(session).tryAcquire("in-flight-prompt")).toBe(
      true,
    );

    const runtime = factory.retainBusySession(graph, {
      sessionId: ACTIVE_SESSION_ID,
      sessionRevision: 4,
      sessionManager: {} as never,
      agentSession: session,
      resourceLoader: {} as never,
      extensionsResult: null,
      toolRevision: 2,
      sessionSnapshot: fakeSessionSnapshot(ACTIVE_SESSION_ID, 4, true),
      unsubscribeAgent: unsubscribe,
      extensionUiActivate: null,
      extensionUiCleanup,
      extensionUiUpdateIdentity: null,
    });

    expect(runtime?.agentSession).toBe(session);
    expect(graph.backgroundSessions.get(ACTIVE_SESSION_ID)).toBe(runtime);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(extensionUiCleanup).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    factory.getSessionOperationLock(session).release("in-flight-prompt");
  });

  it("refuses to park a lock-held session as idle", async () => {
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    const session = fakeSession(true, ACTIVE_SESSION_ID);
    const graph = fakeWorkspaceGraph("C:/workspace", WORKSPACE_ID, session);
    const unsubscribe = vi.fn();
    const extensionUiCleanup = vi.fn();
    expect(factory.getSessionOperationLock(session).tryAcquire("in-flight-prompt")).toBe(
      true,
    );

    const runtime = await factory.retainIdleSession(graph, {
      sessionId: ACTIVE_SESSION_ID,
      sessionRevision: 4,
      sessionManager: {} as never,
      agentSession: session,
      resourceLoader: {} as never,
      extensionsResult: null,
      toolRevision: 2,
      sessionSnapshot: fakeSessionSnapshot(ACTIVE_SESSION_ID, 4, true),
      unsubscribeAgent: unsubscribe,
      extensionUiActivate: null,
      extensionUiCleanup,
      extensionUiUpdateIdentity: null,
    });

    expect(runtime).toBeNull();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(extensionUiCleanup).not.toHaveBeenCalled();
    expect(graph.retainedSessions.size).toBe(0);
    factory.getSessionOperationLock(session).release("in-flight-prompt");
  });

  it("publishes one revisioned queue event for a multi-step transaction", () => {
    const identity: HostIdentity = {
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: ACTIVE_SESSION_ID,
      sessionRevision: 1,
      packageRevision: 1,
    };
    const server = {
      getIdentity: () => identity,
      emitForIdentity: vi.fn(),
    } as unknown as PiHostServer;
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    factory.bindServer(server);
    const session = fakeSession(true, ACTIVE_SESSION_ID);
    const steering: string[] = [];
    const followUp: string[] = [];
    Reflect.set(session, "getSteeringMessages", () => steering);
    Reflect.set(session, "getFollowUpMessages", () => followUp);
    const graph = fakeWorkspaceGraph("C:/workspace", WORKSPACE_ID, session);
    Reflect.set(factory, "graph", graph);
    const internal = factory as unknown as {
      handleAgentEvent: (
        graph: WorkspaceGraph,
        sourceSession: AgentSession,
        event: unknown,
      ) => void;
    };

    factory.beginQueueTransaction(session);
    steering.push("steer first");
    internal.handleAgentEvent(graph, session, {
      type: "queue_update",
      steering: [...steering],
      followUp: [...followUp],
    });
    followUp.push("then this");
    internal.handleAgentEvent(graph, session, {
      type: "queue_update",
      steering: [...steering],
      followUp: [...followUp],
    });

    expect(server.emitForIdentity).not.toHaveBeenCalled();
    expect(factory.finishQueueTransaction(session)).toEqual({
      revision: 1,
      steering: ["steer first"],
      followUp: ["then this"],
    });
    expect(server.emitForIdentity).toHaveBeenCalledOnce();
    expect(server.emitForIdentity).toHaveBeenCalledWith(
      identity,
      "agent.queueChanged",
      {
        revision: 1,
        steering: ["steer first"],
        followUp: ["then this"],
      },
    );
    expect(graph.sessionSnapshot?.pending).toEqual({
      revision: 1,
      steering: ["steer first"],
      followUp: ["then this"],
    });
  });

  it("projects a background Agent event only as Session runtime state", () => {
    const events: Array<{ event: HostEventName; identity: HostIdentity; payload: unknown }> = [];
    const identity: HostIdentity = {
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: ACTIVE_SESSION_ID,
      sessionRevision: 5,
      packageRevision: 1,
    };
    const server = {
      getIdentity: () => identity,
      emitForIdentity: vi.fn(
        (eventIdentity: HostIdentity, event: HostEventName, payload: unknown) => {
          events.push({ identity: eventIdentity, event, payload });
        },
      ),
      setPhase: vi.fn(),
    } as unknown as PiHostServer;
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    factory.bindServer(server);

    const activeSession = fakeSession(true);
    const backgroundSession = fakeSession(false);
    const background = {
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 3,
      agentSession: backgroundSession,
      sessionManager: {},
      sessionSnapshot: {
        sessionId: BACKGROUND_SESSION_ID,
        sessionPath: "C:/sessions/background.jsonl",
        cwd: "C:/workspace",
        revision: 3,
        isStreaming: true,
        isIdle: false,
        isCompacting: false,
        isRetrying: false,
        thinkingLevel: "off",
        autoCompactionEnabled: true,
        autoRetryEnabled: true,
        steeringMode: "all",
        followUpMode: "all",
        pending: { revision: 0, steering: [], followUp: [] },
        messages: [],
        tools: {
          revision: 1,
          workspaceId: WORKSPACE_ID,
          sessionId: BACKGROUND_SESSION_ID,
          sessionRevision: 3,
          tools: [],
          active: [],
        },
      },
      toolRevision: 1,
    } as unknown as BackgroundSessionRuntime;
    const graph = {
      workspaceId: WORKSPACE_ID,
      canonicalCwd: "C:/workspace",
      agentSession: activeSession,
      backgroundSessions: new Map([[BACKGROUND_SESSION_ID, background]]),
    } as unknown as WorkspaceGraph;
    Reflect.set(factory, "graph", graph);

    const internal = factory as unknown as {
      handleAgentEvent: (
        graph: WorkspaceGraph,
        session: AgentSession,
        event: unknown,
      ) => void;
    };
    internal.handleAgentEvent(graph, backgroundSession, { type: "turn_start" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "session.runtimeChanged",
      identity: {
        sessionId: BACKGROUND_SESSION_ID,
        sessionRevision: 3,
      },
      payload: {
        sessionId: BACKGROUND_SESSION_ID,
        sessionRevision: 3,
        state: "running",
      },
    });
  });

  it("keeps active snapshots running at agent_end and idle at agent_settled", () => {
    const events: Array<{ event: HostEventName; payload: unknown }> = [];
    const identity: HostIdentity = {
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: ACTIVE_SESSION_ID,
      sessionRevision: 5,
      packageRevision: 1,
    };
    const server = {
      getIdentity: () => identity,
      emitForIdentity: vi.fn((_identity: HostIdentity, event: HostEventName, payload: unknown) => {
        events.push({ event, payload });
      }),
      setPhase: vi.fn(),
    } as unknown as PiHostServer;
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    factory.bindServer(server);
    const activeSession = fakeSession(false, ACTIVE_SESSION_ID);
    const graph = {
      workspaceId: WORKSPACE_ID,
      canonicalCwd: "C:/workspace",
      agentSession: activeSession,
      sessionManager: {},
      sessionSnapshot: fakeSessionSnapshot(ACTIVE_SESSION_ID, 5, false),
      toolRevision: 1,
      backgroundSessions: new Map(),
    } as unknown as WorkspaceGraph;
    Reflect.set(factory, "graph", graph);

    const internal = factory as unknown as {
      handleAgentEvent: (graph: WorkspaceGraph, session: AgentSession, event: unknown) => void;
    };
    internal.handleAgentEvent(graph, activeSession, { type: "agent_end" });

    const runningSnapshot = events.find((entry) => entry.event === "session.snapshot")
      ?.payload as { isIdle: boolean; isStreaming: boolean };
    expect(runningSnapshot).toMatchObject({ isIdle: false, isStreaming: true });

    Reflect.set(activeSession, "isIdle", true);
    internal.handleAgentEvent(graph, activeSession, { type: "agent_settled" });

    const snapshots = events
      .filter((entry) => entry.event === "session.snapshot")
      .map((entry) => entry.payload as { isIdle: boolean; isStreaming: boolean });
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)).toMatchObject({ isIdle: true, isStreaming: false });
  });

  it("disposes a background session only after agent_settled", async () => {
    vi.useFakeTimers();
    try {
      const serviceGraphLock = new TryMutex();
      const identity: HostIdentity = {
        hostInstanceId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        workspaceRevision: 1,
        sessionId: ACTIVE_SESSION_ID,
        sessionRevision: 5,
        packageRevision: 1,
      };
      const server = {
        getIdentity: () => identity,
        getPhase: vi.fn(() => "agentBusy"),
        emitForIdentity: vi.fn(),
        setPhase: vi.fn(),
        serviceGraphLock,
      } as unknown as PiHostServer;
      const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
      factory.bindServer(server);
      const activeSession = fakeSession(true, ACTIVE_SESSION_ID);
      const backgroundSession = fakeSession(false, BACKGROUND_SESSION_ID);
      const background = {
        sessionId: BACKGROUND_SESSION_ID,
        sessionRevision: 3,
        agentSession: backgroundSession,
        sessionManager: {},
        resourceLoader: {},
        extensionsResult: null,
        toolRevision: 1,
        sessionSnapshot: fakeSessionSnapshot(BACKGROUND_SESSION_ID, 3, false),
        unsubscribeAgent: vi.fn(),
        extensionUiActivate: null,
        extensionUiCleanup: vi.fn(),
        extensionUiUpdateIdentity: null,
      } as unknown as BackgroundSessionRuntime;
      const graph = {
        workspaceId: WORKSPACE_ID,
        canonicalCwd: "C:/workspace",
        agentSession: activeSession,
        backgroundSessions: new Map([[BACKGROUND_SESSION_ID, background]]),
      } as unknown as WorkspaceGraph;
      Reflect.set(factory, "graph", graph);

      const internal = factory as unknown as {
        handleAgentEvent: (graph: WorkspaceGraph, session: AgentSession, event: unknown) => void;
      };
      internal.handleAgentEvent(graph, backgroundSession, { type: "agent_end" });
      await vi.runAllTimersAsync();

      expect(graph.backgroundSessions.get(BACKGROUND_SESSION_ID)).toBe(background);
      expect(backgroundSession.abort).not.toHaveBeenCalled();
      expect(backgroundSession.dispose).not.toHaveBeenCalled();
      expect(background.sessionSnapshot).toMatchObject({ isIdle: false, isStreaming: true });
      expect(server.setPhase).not.toHaveBeenCalled();

      expect(
        serviceGraphLock.tryAcquire({
          operationKind: "session.create",
          requestId: "candidate-session",
        }),
      ).toBe(true);
      Reflect.set(backgroundSession, "isIdle", true);
      internal.handleAgentEvent(graph, backgroundSession, { type: "agent_settled" });
      expect(graph.backgroundSessions.get(BACKGROUND_SESSION_ID)).toBe(background);

      await vi.runAllTimersAsync();

      expect(graph.backgroundSessions.get(BACKGROUND_SESSION_ID)).toBe(background);
      expect(backgroundSession.dispose).not.toHaveBeenCalled();
      serviceGraphLock.release("candidate-session");
      await vi.runAllTimersAsync();

      expect(graph.backgroundSessions.has(BACKGROUND_SESSION_ID)).toBe(false);
      expect(backgroundSession.abort).not.toHaveBeenCalled();
      expect(backgroundSession.dispose).toHaveBeenCalledTimes(1);
      expect(server.setPhase).toHaveBeenCalledWith("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("promotes a lock-held idle background Runtime without reporting it idle", async () => {
    const identity = {
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: ACTIVE_SESSION_ID,
      sessionRevision: 5,
      packageRevision: 1,
    };
    const emitted: HostEventName[] = [];
    const server = {
      identity,
      getIdentity: () => ({ ...identity }),
      emit: vi.fn((event: HostEventName) => emitted.push(event)),
      emitForIdentity: vi.fn(),
    } as unknown as PiHostServer;
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    factory.bindServer(server);

    const foreground = fakeSession(true, ACTIVE_SESSION_ID);
    const backgroundSession = fakeSession(true, BACKGROUND_SESSION_ID);
    expect(
      factory.getSessionOperationLock(backgroundSession).tryAcquire("in-flight-prompt"),
    ).toBe(true);
    const updateIdentity = vi.fn();
    const runtime = {
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 3,
      sessionManager: {},
      agentSession: backgroundSession,
      resourceLoader: {},
      extensionsResult: null,
      toolRevision: 4,
      sessionSnapshot: {
        sessionId: BACKGROUND_SESSION_ID,
        sessionPath: `C:/sessions/${BACKGROUND_SESSION_ID}.jsonl`,
        revision: 3,
      },
      unsubscribeAgent: vi.fn(),
      extensionUiActivate: null,
      extensionUiCleanup: vi.fn(),
      extensionUiUpdateIdentity: updateIdentity,
    } as unknown as BackgroundSessionRuntime;
    const graph = {
      workspaceId: WORKSPACE_ID,
      canonicalCwd: "C:/workspace",
      agentSession: foreground,
      sessionManager: {},
      sessionSnapshot: fakeSessionSnapshot(ACTIVE_SESSION_ID, 5, true),
      resourceLoader: {},
      extensionsResult: null,
      toolRevision: 1,
      extensionUiActivate: null,
      extensionUiCleanup: null,
      extensionUiUpdateIdentity: null,
      unsubscribeAgent: null,
      backgroundSessions: new Map([[BACKGROUND_SESSION_ID, runtime]]),
    } as unknown as WorkspaceGraph;
    Reflect.set(factory, "graph", graph);
    const internal = factory as unknown as {
      promoteBackgroundRuntime: (
        graph: WorkspaceGraph,
        runtime: BackgroundSessionRuntime,
      ) => Promise<{ sessionId: string; revision: number }>;
    };

    const result = await internal.promoteBackgroundRuntime(graph, runtime);

    expect(result).toMatchObject({ sessionId: BACKGROUND_SESSION_ID, revision: 6 });
    expect(graph.agentSession).toBe(backgroundSession);
    expect(graph.backgroundSessions.has(BACKGROUND_SESSION_ID)).toBe(false);
    expect(identity).toMatchObject({
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 6,
    });
    expect(updateIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: BACKGROUND_SESSION_ID, sessionRevision: 6 }),
    );
    expect(foreground.dispose).not.toHaveBeenCalled();
    expect(graph.retainedSessions?.has(ACTIVE_SESSION_ID)).toBe(true);
    expect(emitted).toEqual([
      "session.snapshot",
      "agent.toolsChanged",
      "session.runtimeChanged",
    ]);
    expect(server.emit).toHaveBeenLastCalledWith(
      "session.runtimeChanged",
      expect.objectContaining({ state: "running" }),
    );
    factory.getSessionOperationLock(backgroundSession).release("in-flight-prompt");
  });

  it("reactivates a retained idle Session and parks the previous one", async () => {
    const identity: HostIdentity = {
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: ACTIVE_SESSION_ID,
      sessionRevision: 5,
      packageRevision: 1,
    };
    const emitted: HostEventName[] = [];
    const server = {
      identity,
      getIdentity: () => ({ ...identity }),
      emit: vi.fn((event: HostEventName) => emitted.push(event)),
      emitForIdentity: vi.fn(),
    } as unknown as PiHostServer;
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    factory.bindServer(server);

    const active = fakeSession(true, ACTIVE_SESSION_ID);
    const retained = fakeSession(true, BACKGROUND_SESSION_ID);
    const activeCleanup = vi.fn();
    const activeUnsubscribe = vi.fn();
    const graph = {
      workspaceId: WORKSPACE_ID,
      canonicalCwd: "C:/workspace",
      agentSession: active,
      sessionManager: {},
      sessionSnapshot: fakeSessionSnapshot(ACTIVE_SESSION_ID, 5, true),
      resourceLoader: {},
      extensionsResult: null,
      toolRevision: 1,
      extensionUiActivate: null,
      extensionUiCleanup: activeCleanup,
      extensionUiUpdateIdentity: null,
      unsubscribeAgent: activeUnsubscribe,
      backgroundSessions: new Map(),
      retainedSessions: new Map(),
    } as unknown as WorkspaceGraph;
    Reflect.set(factory, "graph", graph);

    const runtime = await factory.retainIdleSession(graph, {
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 3,
      sessionManager: {} as never,
      agentSession: retained,
      resourceLoader: {} as never,
      extensionsResult: null,
      toolRevision: 2,
      sessionSnapshot: fakeSessionSnapshot(BACKGROUND_SESSION_ID, 3, true),
      unsubscribeAgent: vi.fn(),
      extensionUiActivate: null,
      extensionUiCleanup: vi.fn(),
      extensionUiUpdateIdentity: null,
    });
    expect(runtime).not.toBeNull();

    const result = await factory.promoteRetainedSessionRuntime(graph, runtime!);

    expect(result).toMatchObject({ sessionId: BACKGROUND_SESSION_ID, revision: 6 });
    expect(graph.agentSession).toBe(retained);
    expect(graph.retainedSessions.has(BACKGROUND_SESSION_ID)).toBe(false);
    expect(graph.retainedSessions.has(ACTIVE_SESSION_ID)).toBe(true);
    expect(active.dispose).not.toHaveBeenCalled();
    expect(activeCleanup).toHaveBeenCalledTimes(1);
    expect(activeUnsubscribe).toHaveBeenCalledTimes(1);
    expect(retained.bindExtensions).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([
      "session.snapshot",
      "agent.toolsChanged",
      "session.runtimeChanged",
    ]);
  });

  it("bounds retained idle Sessions and disposes the oldest runtime", async () => {
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    const graph = { retainedSessions: new Map() } as unknown as WorkspaceGraph;
    const sessions = Array.from({ length: 4 }, (_, index) =>
      fakeSession(true, `retained-${index}`),
    );

    for (const [index, session] of sessions.entries()) {
      await factory.retainIdleSession(graph, {
        sessionId: session.sessionId,
        sessionRevision: index + 1,
        sessionManager: {} as never,
        agentSession: session,
        resourceLoader: {} as never,
        extensionsResult: null,
        toolRevision: 1,
        sessionSnapshot: fakeSessionSnapshot(session.sessionId, index + 1, true),
        unsubscribeAgent: vi.fn(),
        extensionUiActivate: null,
        extensionUiCleanup: vi.fn(),
        extensionUiUpdateIdentity: null,
      });
    }

    expect(graph.retainedSessions.size).toBe(3);
    expect(graph.retainedSessions.has("retained-0")).toBe(false);
    expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(sessions.slice(1).every((session) => graph.retainedSessions.has(session.sessionId))).toBe(
      true,
    );
  });

  it("rejects disk reload while the active Session is running", async () => {
    const identity = {
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: ACTIVE_SESSION_ID,
      sessionRevision: 5,
      packageRevision: 1,
    };
    const server = {
      identity,
      serviceGraphLock: new TryMutex(),
      graphOperations: new GraphOperationRegistry(),
    } as unknown as PiHostServer;
    const factory = new WorkspaceGraphFactory({} as GraphFactoryDeps);
    factory.bindServer(server);
    const activeSession = fakeSession(false, ACTIVE_SESSION_ID);
    const sessionPath = `C:/sessions/${ACTIVE_SESSION_ID}.jsonl`;
    Reflect.set(factory, "graph", {
      canonicalCwd: "C:/workspace",
      servicesReady: true,
      settingsManager: {},
      resourceLoader: {},
      agentSession: activeSession,
      sessionSnapshot: {
        sessionId: ACTIVE_SESSION_ID,
        sessionPath,
        revision: 5,
      },
      backgroundSessions: new Map(),
    } as unknown as WorkspaceGraph);

    const result = await factory.reloadSession("reload-running");

    expect("error" in result && result.error.code).toBe("AGENT_BUSY");
    expect(server.serviceGraphLock.isHeld()).toBe(false);
    expect(server.graphOperations.getActive()).toBeNull();
  });
});

describe("WorkspaceGraphFactory retained Workspace recovery", () => {
  function setup(providerOwnership?: ExtensionProviderOwnership) {
    const root = mkdtempSync(join(tmpdir(), "pideck-retained-workspace-"));
    const agentDir = join(root, "agent");
    const currentDir = join(root, "current");
    const retainedDir = join(root, "retained");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
    mkdirSync(retainedDir, { recursive: true });
    const canonicalCurrentDir = realpathSync(currentDir);
    const canonicalRetainedDir = realpathSync(retainedDir);

    const identity: HostIdentity = {
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 7,
      sessionId: ACTIVE_SESSION_ID,
      sessionRevision: 9,
      packageRevision: 4,
    };
    const server = {
      identity,
      serviceGraphLock: new TryMutex(),
      graphOperations: new GraphOperationRegistry(),
      getIdentity: () => ({ ...identity }),
      emit: vi.fn(),
      emitForIdentity: vi.fn(),
      setPhase: vi.fn(),
      setLastError: vi.fn(),
    } as unknown as PiHostServer;
    const factory = new WorkspaceGraphFactory({
      agentDir,
      packageUpdateCheck: false,
      ...(providerOwnership ? { providerOwnership } : {}),
    } as GraphFactoryDeps);
    factory.bindServer(server);

    const previous = fakeWorkspaceGraph(
      canonicalCurrentDir,
      WORKSPACE_ID,
      fakeSession(true, ACTIVE_SESSION_ID),
    );
    Reflect.set(factory, "graph", previous);
    const factoryInternals = factory as unknown as {
      workspaceLifecycle: {
        retainGraph: (graph: WorkspaceGraph) => Promise<void>;
        tryReactivateRetainedGraph: (args: {
          canonical: string;
          previousGraph: WorkspaceGraph | null;
          revision: number;
          sessionRevision: number;
          packageRevision: number;
          signal?: AbortSignal;
        }) => Promise<unknown>;
        retainedGraphFingerprint: (
          graph: WorkspaceGraph,
          signal?: AbortSignal,
        ) => Promise<string>;
        buildServices: () => Promise<{ graph: WorkspaceGraph }>;
        disposeRetainedGraphs: () => Promise<void>;
      };
      sessionRuntimeCache: {
        disposeRetainedSessionRuntimes: (graph: WorkspaceGraph) => Promise<void>;
      };
    };
    const internal = factoryInternals.workspaceLifecycle;

    return {
      root,
      agentDir,
      retainedDir: canonicalRetainedDir,
      identity,
      server,
      factory,
      previous,
      internal,
      sessionRuntimeCache: factoryInternals.sessionRuntimeCache,
    };
  }

  it("keeps the active graph and identity when retained graph preparation fails", async () => {
    const state = setup();
    try {
      const retainedSession = fakeSession(true, BACKGROUND_SESSION_ID);
      const retained = fakeWorkspaceGraph(
        state.retainedDir,
        "55555555-5555-4555-8555-555555555555",
        retainedSession,
      );
      retained.packageManager = null;
      await state.internal.retainGraph(retained);
      const originalIdentity = { ...state.identity };

      const result = await state.internal.tryReactivateRetainedGraph({
        canonical: state.retainedDir,
        previousGraph: state.previous,
        revision: 8,
        sessionRevision: 10,
        packageRevision: 5,
      });

      expect(result).toBeNull();
      expect(state.factory.getGraph()).toBe(state.previous);
      expect(state.identity).toEqual(originalIdentity);
      expect(state.previous.extensionUiCleanup).not.toHaveBeenCalled();
      expect(state.previous.unsubscribeAgent).not.toHaveBeenCalled();
      expect(retainedSession.dispose).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("keeps the active graph when a newly built Workspace fails activation", async () => {
    const state = setup();
    try {
      const candidateSession = fakeSession(true, BACKGROUND_SESSION_ID);
      const candidate = fakeWorkspaceGraph(
        state.retainedDir,
        "88888888-8888-4888-8888-888888888888",
        candidateSession,
      );
      vi.spyOn(
        state.internal as unknown as {
          buildServices: () => Promise<{ graph: WorkspaceGraph }>;
        },
        "buildServices",
      ).mockResolvedValue({ graph: candidate });
      candidate.extensionUiActivate = async () => {
        throw new Error("extension activation failed");
      };
      const originalIdentity = { ...state.identity };

      const result = await state.factory.setCurrent(state.retainedDir, "switch-failed");

      expect("error" in result && result.error.code).toBe("WORKSPACE_SWITCH_FAILED");
      expect(state.factory.getGraph()).toBe(state.previous);
      expect(state.identity).toEqual(originalIdentity);
      expect(state.previous.extensionUiCleanup).not.toHaveBeenCalled();
      expect(state.previous.unsubscribeAgent).not.toHaveBeenCalled();
      expect(candidateSession.dispose).toHaveBeenCalledTimes(1);
      expect(state.server.setPhase).toHaveBeenCalledWith("ready");
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("does not merge same-id Provider state across fresh and retained Workspace switches", async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const ownership = new ExtensionProviderOwnership(runtime);
    const state = setup(ownership);
    try {
      const providerId = "workspace-shared-provider";
      const ownerA = ownership.createOwner("workspace:A");
      const ownerB = ownership.createOwner("workspace:B");
      const configA = workspaceProviderConfig(
        "https://workspace-a.invalid/v1",
        "test-workspace-a-key",
      );
      const configB = { baseUrl: "https://workspace-b.invalid/v1" };
      ownership.runAsOwner(ownerA, () => runtime.registerProvider(providerId, configA));
      state.previous.providerOwner = ownerA;

      const candidate = fakeWorkspaceGraph(
        state.retainedDir,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        fakeSession(true, BACKGROUND_SESSION_ID),
      );
      candidate.providerOwner = ownerB;
      const buildServices = vi.spyOn(state.internal, "buildServices").mockImplementation(
        async () => {
          ownership.runAsOwner(ownerB, () => runtime.registerProvider(providerId, configB));
          return { graph: candidate };
        },
      );

      const selectedB = await state.factory.setCurrent(state.retainedDir, "switch-to-b");

      expect("error" in selectedB).toBe(false);
      expect(runtime.getRegisteredProviderConfig(providerId)).toEqual(configB);
      expect(ownership.ownersOf(providerId)).toEqual(["workspace:B"]);

      const selectedA = await state.factory.setCurrent(
        state.previous.canonicalCwd,
        "switch-back-to-a",
      );

      expect("error" in selectedA).toBe(false);
      expect(buildServices).toHaveBeenCalledTimes(1);
      expect(runtime.getRegisteredProviderConfig(providerId)).toEqual(configA);
      expect(ownership.ownersOf(providerId)).toEqual(["workspace:A"]);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("restores the outgoing Provider owner when candidate activation fails", async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const ownership = new ExtensionProviderOwnership(runtime);
    const state = setup(ownership);
    try {
      const providerId = "workspace-rollback-provider";
      const ownerA = ownership.createOwner("workspace:A");
      const ownerB = ownership.createOwner("workspace:B");
      const configA = workspaceProviderConfig(
        "https://workspace-a.invalid/v1",
        "test-workspace-a-key",
      );
      ownership.runAsOwner(ownerA, () => runtime.registerProvider(providerId, configA));
      state.previous.providerOwner = ownerA;

      const candidate = fakeWorkspaceGraph(
        state.retainedDir,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        fakeSession(true, BACKGROUND_SESSION_ID),
      );
      candidate.providerOwner = ownerB;
      candidate.extensionUiActivate = async () => {
        throw new Error("extension activation failed");
      };
      vi.spyOn(state.internal, "buildServices").mockImplementation(async () => {
        ownership.runAsOwner(ownerB, () =>
          runtime.registerProvider(providerId, {
            baseUrl: "https://workspace-b.invalid/v1",
          }),
        );
        return { graph: candidate };
      });

      const result = await state.factory.setCurrent(state.retainedDir, "switch-rollback-owner");

      expect("error" in result && result.error.code).toBe("WORKSPACE_SWITCH_FAILED");
      expect(state.factory.getGraph()).toBe(state.previous);
      expect(runtime.getRegisteredProviderConfig(providerId)).toEqual(configA);
      expect(ownership.ownersOf(providerId)).toEqual(["workspace:A"]);
      expect(state.previous.suspendedProviders).toBeUndefined();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("cancels a supervised Workspace before candidate commit", async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const ownership = new ExtensionProviderOwnership(runtime);
    const state = setup(ownership);
    try {
      const providerId = "workspace-cancel-provider";
      const ownerA = ownership.createOwner("workspace:A");
      const ownerB = ownership.createOwner("workspace:B");
      const configA = workspaceProviderConfig(
        "https://workspace-a.invalid/v1",
        "test-workspace-a-key",
      );
      ownership.runAsOwner(ownerA, () => runtime.registerProvider(providerId, configA));
      state.previous.providerOwner = ownerA;
      const resumeOwner = vi.spyOn(ownership, "resumeOwner");
      const candidateSession = fakeSession(true, BACKGROUND_SESSION_ID);
      const candidate = fakeWorkspaceGraph(
        state.retainedDir,
        "99999999-9999-4999-8999-999999999999",
        candidateSession,
      );
      candidate.providerOwner = ownerB;
      let resolveBuild!: (value: { graph: WorkspaceGraph }) => void;
      const buildServices = vi
        .spyOn(
          state.internal as unknown as {
            buildServices: () => Promise<{ graph: WorkspaceGraph }>;
          },
          "buildServices",
        )
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveBuild = resolve;
            }),
        );
      const originalIdentity = { ...state.identity };

      const switching = state.factory.setCurrent(state.retainedDir, "switch-cancelled");
      await vi.waitFor(() => expect(buildServices).toHaveBeenCalledOnce());
      const operation = state.server.graphOperations.getActive();
      expect(operation?.operationKind).toBe("workspace.setCurrent");
      operation?.cancel("Host shutdown");
      resolveBuild({ graph: candidate });
      const result = await switching;

      expect("error" in result && result.error).toMatchObject({
        code: "WORKSPACE_SWITCH_FAILED",
        retryable: true,
      });
      expect(state.factory.getGraph()).toBe(state.previous);
      expect(state.identity).toEqual(originalIdentity);
      expect(resumeOwner).toHaveBeenCalledTimes(1);
      expect(runtime.getRegisteredProviderConfig(providerId)).toEqual(configA);
      expect(ownership.ownersOf(providerId)).toEqual(["workspace:A"]);
      expect(state.previous.suspendedProviders).toBeUndefined();
      expect(candidateSession.dispose).toHaveBeenCalledTimes(1);
      expect(state.server.serviceGraphLock.isHeld()).toBe(false);
      expect(state.server.graphOperations.getActive()).toBeNull();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("cancels the outgoing retain fingerprint during a Workspace switch", async () => {
    const state = setup();
    try {
      const previousSession = state.previous.agentSession!;
      const candidateSession = fakeSession(true, BACKGROUND_SESSION_ID);
      const candidate = fakeWorkspaceGraph(
        state.retainedDir,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        candidateSession,
      );
      vi.spyOn(
        state.internal as unknown as {
          buildServices: () => Promise<{ graph: WorkspaceGraph }>;
        },
        "buildServices",
      ).mockResolvedValue({ graph: candidate });

      let markFingerprintStarted!: () => void;
      const fingerprintStarted = new Promise<void>((resolve) => {
        markFingerprintStarted = resolve;
      });
      let releaseFingerprint!: () => void;
      let receivedSignal: AbortSignal | undefined;
      vi.spyOn(state.internal, "retainedGraphFingerprint").mockImplementation(
        (_graph, signal) =>
          new Promise((resolve, reject) => {
            receivedSignal = signal;
            releaseFingerprint = () => resolve("outgoing-fingerprint");
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            markFingerprintStarted();
          }),
      );

      const switching = state.factory.setCurrent(state.retainedDir, "switch-retain-cancelled");
      await fingerprintStarted;
      const operation = state.server.graphOperations.getActive();
      expect(operation?.operationKind).toBe("workspace.setCurrent");
      operation?.cancel("Host shutdown");
      releaseFingerprint();

      const result = await switching;

      expect(receivedSignal).toBe(operation?.signal);
      expect("error" in result && result.error).toMatchObject({
        code: "WORKSPACE_SWITCH_FAILED",
        retryable: true,
      });
      expect(state.factory.getGraph()).toBe(candidate);
      expect(previousSession.dispose).toHaveBeenCalledTimes(1);
      expect(state.server.serviceGraphLock.isHeld()).toBe(false);
      expect(state.server.graphOperations.getActive()).toBeNull();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("rolls back the active graph and identity when retained activation fails", async () => {
    const state = setup();
    try {
      const retainedSession = fakeSession(true, BACKGROUND_SESSION_ID);
      Reflect.set(
        retainedSession,
        "bindExtensions",
        vi.fn(async () => {
          throw new Error("extension activation failed");
        }),
      );
      const retained = fakeWorkspaceGraph(
        state.retainedDir,
        "66666666-6666-4666-8666-666666666666",
        retainedSession,
      );
      await state.internal.retainGraph(retained);
      const originalIdentity = { ...state.identity };

      const result = await state.internal.tryReactivateRetainedGraph({
        canonical: state.retainedDir,
        previousGraph: state.previous,
        revision: 8,
        sessionRevision: 10,
        packageRevision: 5,
      });

      expect(result).toBeNull();
      expect(state.factory.getGraph()).toBe(state.previous);
      expect(state.identity).toEqual(originalIdentity);
      expect(state.previous.extensionUiCleanup).not.toHaveBeenCalled();
      expect(state.previous.unsubscribeAgent).not.toHaveBeenCalled();
      expect(retainedSession.dispose).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("discards a retained graph when project resources changed on disk", async () => {
    const state = setup();
    try {
      const retainedSession = fakeSession(true, BACKGROUND_SESSION_ID);
      const retained = fakeWorkspaceGraph(
        state.retainedDir,
        "77777777-7777-4777-8777-777777777777",
        retainedSession,
      );
      await state.internal.retainGraph(retained);
      const extensionsDir = join(state.retainedDir, ".pi", "extensions");
      mkdirSync(extensionsDir, { recursive: true });
      writeFileSync(join(extensionsDir, "changed.ts"), "export default () => {};\n");

      const result = await state.internal.tryReactivateRetainedGraph({
        canonical: state.retainedDir,
        previousGraph: state.previous,
        revision: 8,
        sessionRevision: 10,
        packageRevision: 5,
      });

      expect(result).toBeNull();
      expect(state.factory.getGraph()).toBe(state.previous);
      expect(retainedSession.bindExtensions).not.toHaveBeenCalled();
      expect(retainedSession.dispose).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("fingerprints configured package files without dependency or VCS internals", async () => {
    const state = setup();
    try {
      const retained = fakeWorkspaceGraph(
        state.retainedDir,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        fakeSession(true, BACKGROUND_SESSION_ID),
      );
      const installedPath = join(
        state.retainedDir,
        ".pi",
        "npm",
        "node_modules",
        "example-package",
      );
      const dependencyFile = join(installedPath, "node_modules", "dependency", "index.js");
      const gitObject = join(installedPath, ".git", "objects", "test-object");
      const manifest = join(installedPath, "package.json");
      mkdirSync(join(installedPath, "node_modules", "dependency"), { recursive: true });
      mkdirSync(join(installedPath, ".git", "objects"), { recursive: true });
      writeFileSync(dependencyFile, "dependency-v1\n");
      writeFileSync(gitObject, "object-v1\n");
      writeFileSync(manifest, JSON.stringify({ name: "example-package", version: "1.0.0" }));
      retained.packageManager!.listConfiguredPackages = () => [
        {
          source: "npm:example-package",
          scope: "project",
          filtered: false,
          installedPath,
        },
      ];

      const first = await state.internal.retainedGraphFingerprint(retained);
      writeFileSync(dependencyFile, "dependency-v2-with-different-size\n");
      writeFileSync(gitObject, "object-v2-with-different-size\n");
      const internalsChanged = await state.internal.retainedGraphFingerprint(retained);
      writeFileSync(
        manifest,
        JSON.stringify({ name: "example-package", version: "22.0.0" }),
      );
      const packageChanged = await state.internal.retainedGraphFingerprint(retained);

      expect(internalsChanged).toBe(first);
      expect(packageChanged).not.toBe(internalsChanged);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("discards a retained graph when models-store.json is created", async () => {
    const state = setup();
    try {
      const retainedSession = fakeSession(true, BACKGROUND_SESSION_ID);
      const retained = fakeWorkspaceGraph(
        state.retainedDir,
        "77777777-7777-4777-8777-777777777777",
        retainedSession,
      );
      await state.internal.retainGraph(retained);
      writeFileSync(
        join(state.agentDir, "models-store.json"),
        JSON.stringify({ custom: { source: "runtime" } }),
      );

      const result = await state.internal.tryReactivateRetainedGraph({
        canonical: state.retainedDir,
        previousGraph: state.previous,
        revision: 8,
        sessionRevision: 10,
        packageRevision: 5,
      });

      expect(result).toBeNull();
      expect(state.factory.getGraph()).toBe(state.previous);
      expect(retainedSession.bindExtensions).not.toHaveBeenCalled();
      expect(retainedSession.dispose).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("disposes a retained graph when fingerprinting is cancelled", async () => {
    const state = setup();
    try {
      const retainedSession = fakeSession(true, BACKGROUND_SESSION_ID);
      const retained = fakeWorkspaceGraph(
        state.retainedDir,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        retainedSession,
      );
      await state.internal.retainGraph(retained);

      let markFingerprintStarted!: () => void;
      const fingerprintStarted = new Promise<void>((resolve) => {
        markFingerprintStarted = resolve;
      });
      vi.spyOn(state.internal, "retainedGraphFingerprint").mockImplementation(
        (_graph, signal) =>
          new Promise((_resolve, reject) => {
            markFingerprintStarted();
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );
      const controller = new AbortController();

      const reactivating = state.internal.tryReactivateRetainedGraph({
        canonical: state.retainedDir,
        previousGraph: state.previous,
        revision: 8,
        sessionRevision: 10,
        packageRevision: 5,
        signal: controller.signal,
      });
      await fingerprintStarted;
      controller.abort(new Error("Host shutdown"));

      await expect(reactivating).rejects.toThrow("Host shutdown");
      expect(state.factory.getGraph()).toBe(state.previous);
      expect(retainedSession.dispose).toHaveBeenCalledTimes(1);
      await state.internal.disposeRetainedGraphs();
      expect(retainedSession.dispose).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it("invalidates retained Session and Workspace runtimes together", async () => {
    const state = setup();
    try {
      const disposeSessions = vi
        .spyOn(state.sessionRuntimeCache, "disposeRetainedSessionRuntimes")
        .mockResolvedValue();
      const disposeWorkspaces = vi
        .spyOn(state.internal, "disposeRetainedGraphs")
        .mockResolvedValue();

      await state.factory.invalidateRetainedRuntimeCaches();

      expect(disposeSessions).toHaveBeenCalledWith(state.previous);
      expect(disposeWorkspaces).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });
});
