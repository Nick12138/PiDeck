import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

const createSessionMock = vi.fn();
const openSessionMock = vi.fn();
const reloadSessionMock = vi.fn();
const prepareForkFileMock = vi.fn();
const buildSessionSnapshotMock = vi.fn((..._args: unknown[]) => ({ built: "snapshot" }));

vi.mock("./session-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-lifecycle.js")>();
  return {
    ...actual,
    createSession: (...args: unknown[]) => createSessionMock(...args),
    openSession: (...args: unknown[]) => openSessionMock(...args),
    reloadSession: (...args: unknown[]) => reloadSessionMock(...args),
    prepareForkFile: (...args: unknown[]) => prepareForkFileMock(...args),
  };
});

vi.mock("./session-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-snapshot.js")>();
  return {
    ...actual,
    buildSessionSnapshot: (...args: unknown[]) => buildSessionSnapshotMock(...args),
  };
});

import { createExtensionCommandContextActions } from "./extension-command-actions.js";

function fixture() {
  const identity = {
    hostInstanceId: "host-1",
    workspaceId: "ws-1",
    workspaceRevision: 1,
    sessionId: "session-1",
    sessionRevision: 3,
    packageRevision: 0,
  };
  const session = {
    waitForIdle: vi.fn(async () => undefined),
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    createReplacedSessionContext: vi.fn(() => ({ replaced: true })),
  };
  const graph = {
    agentSession: session as unknown,
    sessionManager: { getSessionFile: () => "C:/sessions/session-1.jsonl" },
    canonicalCwd: "C:/workspace",
    workspaceId: "ws-1",
    toolRevision: 1,
    sessionSnapshot: null as unknown,
  };
  const server = {
    getIdentity: () => ({ ...identity }),
    emit: vi.fn(),
  };
  const factory = {
    getGraph: () => graph,
    getServer: () => server,
  } as unknown as WorkspaceGraphFactory;
  return { factory, graph, server, session };
}

describe("createExtensionCommandContextActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("waitForIdle delegates to the bound session", async () => {
    const { factory, session } = fixture();
    const actions = createExtensionCommandContextActions({
      factory,
      session: session as unknown as AgentSession,
    });

    await actions.waitForIdle();

    expect(session.waitForIdle).toHaveBeenCalledOnce();
  });

  it("newSession threads parentSession/setup through createSession and runs withSession after commit", async () => {
    const { factory, session } = fixture();
    createSessionMock.mockResolvedValue({ sessionId: "session-2" });
    const actions = createExtensionCommandContextActions({
      factory,
      session: session as unknown as AgentSession,
    });
    const setup = vi.fn(async () => undefined);
    const withSession = vi.fn(async () => undefined);

    const outcome = await actions.newSession({
      parentSession: "C:/sessions/parent.jsonl",
      setup,
      withSession,
    });

    expect(outcome).toEqual({ cancelled: false });
    expect(createSessionMock).toHaveBeenCalledOnce();
    const [targetFactory, requestId, name, options] = createSessionMock.mock.calls[0]!;
    expect(targetFactory).toBe(factory);
    expect(typeof requestId).toBe("string");
    expect(name).toBeUndefined();
    expect(options).toEqual({ parentSession: "C:/sessions/parent.jsonl", setup });
    expect(session.createReplacedSessionContext).toHaveBeenCalledOnce();
    expect(withSession).toHaveBeenCalledWith({ replaced: true });
  });

  it("newSession throws the Host error message and skips withSession on failure", async () => {
    const { factory, session } = fixture();
    createSessionMock.mockResolvedValue({ error: { message: "Service graph is busy" } });
    const actions = createExtensionCommandContextActions({
      factory,
      session: session as unknown as AgentSession,
    });
    const withSession = vi.fn(async () => undefined);

    await expect(actions.newSession({ withSession })).rejects.toThrow(
      "Service graph is busy",
    );
    expect(withSession).not.toHaveBeenCalled();
  });

  it("fork prepares the file then opens the fork with position passthrough", async () => {
    const { factory, session } = fixture();
    prepareForkFileMock.mockReturnValue({ forkedPath: "C:/sessions/fork.jsonl" });
    openSessionMock.mockResolvedValue({ sessionId: "session-fork" });
    const actions = createExtensionCommandContextActions({
      factory,
      session: session as unknown as AgentSession,
    });
    const withSession = vi.fn(async () => undefined);

    const outcome = await actions.fork("entry-9", { position: "at", withSession });

    expect(outcome).toEqual({ cancelled: false });
    expect(prepareForkFileMock).toHaveBeenCalledWith({
      sessionFile: "C:/sessions/session-1.jsonl",
      canonicalCwd: "C:/workspace",
      entryId: "entry-9",
      position: "at",
    });
    expect(openSessionMock).toHaveBeenCalledWith(
      factory,
      expect.any(String),
      "C:/sessions/fork.jsonl",
    );
    expect(withSession).toHaveBeenCalledWith({ replaced: true });
  });

  it("fork throws when the session cannot be forked yet", async () => {
    const { factory, session } = fixture();
    prepareForkFileMock.mockReturnValue({
      error: { message: "This session has not been saved yet." },
    });
    const actions = createExtensionCommandContextActions({
      factory,
      session: session as unknown as AgentSession,
    });

    await expect(actions.fork("entry-9")).rejects.toThrow(
      "This session has not been saved yet.",
    );
    expect(openSessionMock).not.toHaveBeenCalled();
  });

  it("navigateTree passes extension options through and publishes the rebuilt snapshot", async () => {
    const { factory, graph, server, session } = fixture();
    session.navigateTree.mockResolvedValue({ cancelled: true });
    const actions = createExtensionCommandContextActions({
      factory,
      session: session as unknown as AgentSession,
    });

    const outcome = await actions.navigateTree("leaf-4", {
      summarize: true,
      customInstructions: "keep it short",
      label: "branch point",
    });

    expect(outcome).toEqual({ cancelled: true });
    expect(session.navigateTree).toHaveBeenCalledWith("leaf-4", {
      summarize: true,
      customInstructions: "keep it short",
      label: "branch point",
    });
    expect(graph.sessionSnapshot).toEqual({ built: "snapshot" });
    expect(server.emit).toHaveBeenCalledWith("session.snapshot", { built: "snapshot" });
  });

  it("navigateTree refuses to run on a session that is no longer active", async () => {
    const { factory, graph, session } = fixture();
    graph.agentSession = { other: true };
    const actions = createExtensionCommandContextActions({
      factory,
      session: session as unknown as AgentSession,
    });

    await expect(actions.navigateTree("leaf-4")).rejects.toThrow(
      "Session is no longer the active session",
    );
    expect(session.navigateTree).not.toHaveBeenCalled();
  });

  it("switchSession opens the target path and runs withSession after commit", async () => {
    const { factory, session } = fixture();
    openSessionMock.mockResolvedValue({ sessionId: "session-3" });
    const actions = createExtensionCommandContextActions({
      factory,
      session: session as unknown as AgentSession,
    });
    const withSession = vi.fn(async () => undefined);

    const outcome = await actions.switchSession("C:/sessions/session-3.jsonl", {
      withSession,
    });

    expect(outcome).toEqual({ cancelled: false });
    expect(openSessionMock).toHaveBeenCalledWith(
      factory,
      expect.any(String),
      "C:/sessions/session-3.jsonl",
    );
    expect(withSession).toHaveBeenCalledWith({ replaced: true });
  });

  it("reload goes through the host-level reload and throws on failure", async () => {
    const { factory, session } = fixture();
    reloadSessionMock.mockResolvedValue({
      error: { message: "The active Session has not been persisted to disk yet" },
    });
    const actions = createExtensionCommandContextActions({
      factory,
      session: session as unknown as AgentSession,
    });

    await expect(actions.reload()).rejects.toThrow(
      "The active Session has not been persisted to disk yet",
    );
    expect(reloadSessionMock).toHaveBeenCalledWith(factory, expect.any(String));
  });
});
