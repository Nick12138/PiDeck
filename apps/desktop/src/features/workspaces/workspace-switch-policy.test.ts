import { describe, expect, it } from "vitest";
import type { AppState } from "../../lib/stores/app-store";
import { emptySessionCatalog } from "../../lib/stores/session-catalog";
import {
  isWorkspaceSwitchBusyError,
  workspaceActivationReady,
  workspaceHasActiveAgent,
} from "./workspace-switch-policy";

function runtime(overrides: Partial<Pick<AppState, "session" | "sessionCatalog">> = {}) {
  return {
    session: null,
    sessionCatalog: emptySessionCatalog(),
    ...overrides,
  } as Pick<AppState, "session" | "sessionCatalog">;
}

describe("workspace switch policy", () => {
  it("reuses the active Host when no Agent is running", () => {
    expect(workspaceHasActiveAgent(runtime())).toBe(false);
  });

  it.each(["starting", "running", "queued"] as const)(
    "requests an isolated Host for a %s background Session",
    (runtimeState) => {
      const sessionCatalog = emptySessionCatalog();
      sessionCatalog.entries.s1 = {
        sessionId: "s1",
        sessionPath: "s1.jsonl",
        cwd: "C:/workspace",
        updatedAt: 1,
        messageCount: 1,
        runtimeState,
      };
      expect(workspaceHasActiveAgent(runtime({ sessionCatalog }))).toBe(true);
    },
  );

  it("recognizes Host busy races that require forced isolation", () => {
    expect(isWorkspaceSwitchBusyError({ code: "AGENT_BUSY" })).toBe(true);
    expect(isWorkspaceSwitchBusyError({ code: "SERVICE_GRAPH_BUSY" })).toBe(true);
    expect(isWorkspaceSwitchBusyError({ code: "INVALID_PARAMS" })).toBe(false);
  });

  it("settles activation only after the new Host session snapshot is applied", () => {
    const state = {
      host: {
        hostInstanceId: "host-b",
        workspaceId: "workspace-b",
        workspaceRevision: 2,
        sessionId: "session-b",
        sessionRevision: 3,
      },
      workspace: {
        id: "workspace-b",
        revision: 2,
        servicesReady: true,
      },
      session: {
        sessionId: "session-b",
        revision: 2,
      },
      connecting: false,
      rehydrating: false,
      desynchronized: false,
      hostFatal: null,
    } as Pick<
      AppState,
      | "host"
      | "workspace"
      | "session"
      | "connecting"
      | "rehydrating"
      | "desynchronized"
      | "hostFatal"
    >;

    expect(workspaceActivationReady(state, "host-a")).toBe(false);
    expect(
      workspaceActivationReady({ ...state, session: { ...state.session!, revision: 3 } }, "host-a"),
    ).toBe(true);
    expect(workspaceActivationReady({ ...state, rehydrating: true }, "host-a")).toBe(false);
  });
});
