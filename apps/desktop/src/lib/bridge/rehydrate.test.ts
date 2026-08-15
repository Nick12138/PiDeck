import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock, getHostInstanceIdMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  getHostInstanceIdMock: vi.fn(),
}));

vi.mock("./host-client", () => ({
  hostClient: {
    request: requestMock,
    getHostInstanceId: getHostInstanceIdMock,
  },
}));

import { RecoveryEventBuffer, fullRehydrate, resolveRehydrateHostInstanceId } from "./rehydrate";

beforeEach(() => {
  requestMock.mockReset();
  getHostInstanceIdMock.mockReset();
});

describe("resolveRehydrateHostInstanceId", () => {
  it("keeps the Host identity returned by hello during restart recovery", () => {
    expect(resolveRehydrateHostInstanceId("hello-host", null)).toBe("hello-host");
    expect(resolveRehydrateHostInstanceId("hello-host", "stale-host")).toBe("hello-host");
  });

  it("falls back to the client identity outside an explicit recovery", () => {
    expect(resolveRehydrateHostInstanceId(undefined, "current-host")).toBe("current-host");
    expect(resolveRehydrateHostInstanceId(undefined, null)).toBeNull();
  });
});

describe("fullRehydrate", () => {
  it("reads one atomic Host snapshot with its event watermark", async () => {
    const host = {
      hostInstanceId: "host-2",
      workspaceId: "workspace-2",
      workspaceRevision: 4,
      sessionId: "session-2",
      sessionRevision: 6,
      packageRevision: 3,
    };
    const workspace = {
      id: "workspace-2",
      cwd: "C:/workspace",
      canonicalCwd: "C:/workspace",
      revision: 4,
      servicesReady: true,
    };
    const session = {
      sessionId: "session-2",
      revision: 6,
      tools: { revision: 1, tools: [], active: [] },
    };
    const tools = { revision: 2, tools: [], active: [] };
    const packages = {
      revision: 3,
      workspaceId: "workspace-2",
      scope: "all",
      configured: [],
      resources: [],
      updateCheck: { supported: false },
      diagnostics: [],
    };
    requestMock.mockResolvedValueOnce({
      ok: true,
      result: { host, workspace, session, tools, packages, watermark: 17 },
    });

    await expect(fullRehydrate("host-2")).resolves.toEqual({
      host,
      workspace,
      session,
      tools,
      packages,
      watermark: 17,
    });
    expect(requestMock.mock.calls.map(([method]) => method)).toEqual(["system.rehydrate"]);
    expect(requestMock.mock.calls[0]?.[1]).toEqual({ expectedHostInstanceId: "host-2" });
  });

  it("returns the atomic no-Workspace snapshot", async () => {
    const host = {
      hostInstanceId: "host-3",
      workspaceId: null,
      workspaceRevision: 0,
      sessionId: null,
      sessionRevision: 0,
      packageRevision: 0,
    };
    getHostInstanceIdMock.mockReturnValue("host-3");
    requestMock.mockResolvedValueOnce({
      ok: true,
      result: {
        host,
        workspace: null,
        session: null,
        packages: null,
        tools: null,
        watermark: 4,
      },
    });

    await expect(fullRehydrate()).resolves.toEqual({
      host,
      workspace: null,
      session: null,
      packages: null,
      tools: null,
      watermark: 4,
    });
    expect(requestMock.mock.calls.map(([method]) => method)).toEqual(["system.rehydrate"]);
  });
});

describe("RecoveryEventBuffer", () => {
  const event = (sequence: number, hostInstanceId = "host-2") =>
    ({
      protocolVersion: 1,
      hostInstanceId,
      workspaceId: "workspace-2",
      workspaceRevision: 4,
      sessionId: "session-2",
      sessionRevision: 6,
      packageRevision: 3,
      sequence,
      timestamp: sequence,
      event: "agent.event",
      payload: {
        runId: "run-1",
        event: { type: "message_update", delta: String(sequence) },
      },
    }) as const;

  it("replays only same-Host events newer than the snapshot watermark", () => {
    const buffer = new RecoveryEventBuffer();
    buffer.begin("host-2");
    expect(buffer.capture(event(10))).toBe(true);
    expect(buffer.capture(event(11))).toBe(true);
    expect(buffer.capture(event(12, "other-host"))).toBe(false);

    expect(buffer.finish("host-2", 10)).toEqual({
      events: [event(11)],
      overflowed: false,
    });
  });

  it("reports overflow instead of pretending dropped recovery events were applied", () => {
    const buffer = new RecoveryEventBuffer(1);
    buffer.begin("host-2");
    expect(buffer.capture(event(10))).toBe(true);
    expect(buffer.capture(event(11))).toBe(true);

    expect(buffer.finish("host-2", 9)).toEqual({
      events: [event(10)],
      overflowed: true,
    });
  });
});
