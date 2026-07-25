import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostIdentity } from "@pideck/protocol";
import { HOST_SHUTDOWN_QUIESCE_TIMEOUT_MS, PiHostServer } from "./server.js";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const BACKGROUND_SESSION_ID = "44444444-4444-4444-8444-444444444444";

function server(): PiHostServer {
  const instance = new PiHostServer({
    agentDir: "C:/agent",
    sdkVersion: "0.80.7",
    getModelConfigHealth: () => ({
      state: "ok",
      source: "ModelRegistry.getError",
    }),
    capabilities: {
      packageUpdateCheck: false,
      extensionUi: true,
      sessionExport: false,
    },
    handlers: {},
  });
  instance.identity.workspaceId = WORKSPACE_ID;
  instance.identity.workspaceRevision = 1;
  instance.identity.sessionId = ACTIVE_SESSION_ID;
  instance.identity.sessionRevision = 2;
  return instance;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PiHostServer.emitForIdentity", () => {
  it("keeps the global sequence while labeling an event with a background Session", async () => {
    const host = server();
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(
      ((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stdout.write,
    );
    const identity: HostIdentity = {
      ...host.getIdentity(),
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 7,
    };

    host.emitForIdentity(identity, "session.runtimeChanged", {
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 7,
      state: "running",
      updatedAt: 1,
    });
    host.emit("host.statusChanged", host.buildStatus());
    // Writes flush asynchronously through the outbound queue.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(first.sessionId).toBe(BACKGROUND_SESSION_ID);
    expect(first.sessionRevision).toBe(7);
    expect(first.sequence).toBe(1);
    expect(second.sessionId).toBe(ACTIVE_SESSION_ID);
    expect(second.sequence).toBe(2);
  });

  it("rejects identities from another Workspace epoch", () => {
    const host = server();
    expect(() =>
      host.emitForIdentity(
        { ...host.getIdentity(), workspaceRevision: 2 },
        "session.runtimeChanged",
        {
          sessionId: ACTIVE_SESSION_ID,
          sessionRevision: 2,
          state: "idle",
          updatedAt: 1,
        },
      ),
    ).toThrow("stale Host or Workspace identity");
  });
});

describe("PiHostServer rehydrate barrier", () => {
  it("returns an atomic no-Workspace snapshot at the preceding event watermark", async () => {
    const host = new PiHostServer({
      agentDir: "C:/agent",
      sdkVersion: "0.80.7",
      getModelConfigHealth: () => ({
        state: "ok",
        source: "ModelRegistry.getError",
      }),
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      handlers: {},
    });
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(
      ((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stdout.write,
    );

    host.emit("host.statusChanged", host.buildStatus());
    const response = host.handleLine(
      JSON.stringify({
        protocolVersion: 1,
        id: "55555555-5555-4555-8555-555555555555",
        method: "system.rehydrate",
        context: { expectedHostInstanceId: host.identity.hostInstanceId },
        params: null,
      }),
    );
    host.emit("host.statusChanged", host.buildStatus());
    await response;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.map((message) => message.sequence ?? message.method)).toEqual([
      1,
      "system.rehydrate",
      2,
    ]);
    expect(parsed[1]).toMatchObject({
      ok: true,
      result: {
        watermark: 1,
        workspace: null,
        session: null,
        tools: null,
        packages: null,
      },
    });
  });
});

describe("PiHostServer shutdown", () => {
  it("cancels and waits for a package mutation before disposing the graph", async () => {
    const dispose = vi.fn(async () => {});
    const host = new PiHostServer({
      agentDir: "C:/agent",
      sdkVersion: "0.80.7",
      getModelConfigHealth: () => ({
        state: "ok",
        source: "ModelRegistry.getError",
      }),
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      handlers: {},
      onShutdown: dispose,
    });
    const shutdown = vi.spyOn(host, "shutdown").mockResolvedValue();
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    expect(
      host.serviceGraphLock.tryAcquire({
        operationKind: "package.mutation",
        requestId: "package-request",
      }),
    ).toBe(true);
    const operation = host.graphOperations.begin({
      operationKind: "package.mutation",
      requestId: "package-request",
      operationId: "package-operation",
    });
    expect(operation).not.toBeNull();

    const handling = host.handleLine(
      JSON.stringify({
        protocolVersion: 1,
        id: "55555555-5555-4555-8555-555555555555",
        method: "system.shutdown",
        context: { expectedHostInstanceId: host.identity.hostInstanceId },
        params: null,
      }),
    );

    await vi.waitFor(() => expect(operation?.signal.aborted).toBe(true));
    expect(dispose).not.toHaveBeenCalled();

    host.serviceGraphLock.release("package-request");
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();
    operation?.finish();
    await handling;

    expect(dispose).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(host.serviceGraphLock.getOwner()).toBeNull();
  });

  it("fails shutdown instead of accepting when graph-lock quiescing times out", async () => {
    vi.useFakeTimers();
    const host = server();
    const shutdown = vi.spyOn(host, "shutdown").mockResolvedValue();
    const writeResponse = vi.spyOn(host, "writeResponse").mockImplementation(() => {});
    host.serviceGraphLock.tryAcquire({
      operationKind: "workspace.setCurrent",
      requestId: "workspace-request",
    });

    const handling = host.handleLine(
      JSON.stringify({
        protocolVersion: 1,
        id: "66666666-6666-4666-8666-666666666666",
        method: "system.shutdown",
        context: { expectedHostInstanceId: host.identity.hostInstanceId },
        params: null,
      }),
    );
    await vi.advanceTimersByTimeAsync(HOST_SHUTDOWN_QUIESCE_TIMEOUT_MS);
    await handling;

    expect(writeResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "HOST_RESTART_REQUIRED" }),
      }),
    );
    expect(shutdown).toHaveBeenCalledWith(1);
  });

  it("applies the shutdown deadline to graph disposal", async () => {
    vi.useFakeTimers();
    const dispose = vi.fn(() => new Promise<void>(() => {}));
    const host = new PiHostServer({
      agentDir: "C:/agent",
      sdkVersion: "0.80.7",
      getModelConfigHealth: () => ({ state: "ok", source: "ModelRegistry.getError" }),
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      handlers: {},
      onShutdown: dispose,
    });
    const shutdown = vi.spyOn(host, "shutdown").mockResolvedValue();
    const writeResponse = vi.spyOn(host, "writeResponse").mockImplementation(() => {});

    const handling = host.handleLine(
      JSON.stringify({
        protocolVersion: 1,
        id: "77777777-7777-4777-8777-777777777777",
        method: "system.shutdown",
        context: { expectedHostInstanceId: host.identity.hostInstanceId },
        params: null,
      }),
    );
    await vi.advanceTimersByTimeAsync(HOST_SHUTDOWN_QUIESCE_TIMEOUT_MS);
    await handling;

    expect(dispose).toHaveBeenCalledOnce();
    expect(writeResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(shutdown).toHaveBeenCalledWith(1);
  });

  it("runs cleanup and transport shutdown exactly once for duplicate signals", async () => {
    const dispose = vi.fn(async () => {});
    const host = new PiHostServer({
      agentDir: "C:/agent",
      sdkVersion: "0.80.7",
      getModelConfigHealth: () => ({ state: "ok", source: "ModelRegistry.getError" }),
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      handlers: {},
      onShutdown: dispose,
    });
    const shutdown = vi.spyOn(host, "shutdown").mockResolvedValue();

    await Promise.all([host.requestShutdown("stdin end"), host.requestShutdown("stdin close")]);

    expect(dispose).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("shares cleanup and transport shutdown between RPC and signal entry points", async () => {
    const dispose = vi.fn(async () => {});
    const host = new PiHostServer({
      agentDir: "C:/agent",
      sdkVersion: "0.80.7",
      getModelConfigHealth: () => ({ state: "ok", source: "ModelRegistry.getError" }),
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      handlers: {},
      onShutdown: dispose,
    });
    const shutdown = vi.spyOn(host, "shutdown").mockResolvedValue();
    vi.spyOn(host, "writeResponse").mockImplementation(() => {});

    const rpc = host.handleLine(
      JSON.stringify({
        protocolVersion: 1,
        id: "88888888-8888-4888-8888-888888888888",
        method: "system.shutdown",
        context: { expectedHostInstanceId: host.identity.hostInstanceId },
        params: null,
      }),
    );
    const signal = host.requestShutdown("SIGTERM");
    await Promise.all([rpc, signal]);

    expect(dispose).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
