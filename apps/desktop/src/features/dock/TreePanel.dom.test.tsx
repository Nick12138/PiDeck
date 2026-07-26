/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  SerializableSessionTreeNode,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { TreePanel } from "./TreePanel";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  };
}

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
    revision: 3,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 1, steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
    ...overrides,
  };
}

const EXPECTED_CONTEXT = {
  expectedHostInstanceId: HOST_ID,
  expectedWorkspaceId: WORKSPACE_ID,
  expectedWorkspaceRevision: 1,
  expectedSessionId: SESSION_ID,
  expectedSessionRevision: 3,
};

// u1 → a1 → { u2 (current leaf), u3 (abandoned branch) }
const TREE: SerializableSessionTreeNode[] = [
  {
    entry: { id: "u1", type: "message", message: { role: "user", content: "first ask" } },
    children: [
      {
        entry: {
          id: "a1",
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "the answer" }] },
        },
        children: [
          {
            entry: {
              id: "u2",
              type: "message",
              message: { role: "user", content: "trunk follow-up" },
            },
            children: [],
          },
          {
            entry: {
              id: "u3",
              type: "message",
              message: { role: "user", content: "abandoned attempt" },
            },
            children: [],
          },
        ],
      },
    ],
  },
];

function envelope(method: string, result: unknown): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: "test-request",
    method,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    ok: true,
    result,
  } as HostResponseEnvelope;
}

describe("TreePanel", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().clearNotifications();
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("loads the tree and navigates to an abandoned branch", async () => {
    const request = vi
      .spyOn(hostClient, "request")
      .mockImplementation(async (method) => {
        if (method === "session.getTree") {
          return envelope("session.getTree", { tree: TREE, leafId: "u2" }) as never;
        }
        return envelope("agent.navigateTree", {
          session: session({ thinkingLevel: "high" }),
          cancelled: false,
          editorText: "abandoned attempt",
        }) as never;
      });
    const user = userEvent.setup();
    render(<TreePanel visible />);

    expect(await screen.findByText("abandoned attempt")).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith("session.getTree", EXPECTED_CONTEXT, null);

    const current = screen.getByText("trunk follow-up").closest("button")!;
    expect(current).toBeDisabled();
    expect(current).toHaveAttribute("aria-current", "true");

    await user.click(screen.getByText("abandoned attempt").closest("button")!);

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.navigateTree",
        EXPECTED_CONTEXT,
        { targetId: "u3" },
      ),
    );
    await waitFor(() =>
      expect(useAppStore.getState().session?.thinkingLevel).toBe("high"),
    );
    expect(useAppStore.getState().sessionDrafts[SESSION_ID]).toBe("abandoned attempt");
  });

  it("disables navigation while the agent is busy", async () => {
    useAppStore
      .getState()
      .applySessionSnapshot(session({ isIdle: false, isStreaming: true }));
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("session.getTree", { tree: TREE, leafId: "u2" }) as never,
    );
    render(<TreePanel visible />);

    expect(await screen.findByText("abandoned attempt")).toBeInTheDocument();
    expect(screen.getByText("Agent is busy — navigation disabled")).toBeInTheDocument();
    expect(screen.getByText("abandoned attempt").closest("button")).toBeDisabled();
  });

  it("forks from a user row via the inline fork button", async () => {
    const request = vi
      .spyOn(hostClient, "request")
      .mockImplementation(async (method) => {
        if (method === "session.getTree") {
          return envelope("session.getTree", { tree: TREE, leafId: "u2" }) as never;
        }
        return envelope("session.fork", {
          session: session(),
          selectedText: "abandoned attempt",
        }) as never;
      });
    const user = userEvent.setup();
    render(<TreePanel visible />);

    await screen.findByText("abandoned attempt");
    await user.click(
      screen.getByRole("button", { name: "Fork from: abandoned attempt" }),
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "session.fork",
        EXPECTED_CONTEXT,
        { entryId: "u3" },
        expect.any(Number),
      ),
    );
  });

  it("shows tree load errors", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ...envelope("session.getTree", undefined),
      ok: false,
      result: undefined,
      error: { code: "HOST_NOT_READY", message: "Server not bound" },
    } as never);
    render(<TreePanel visible />);

    expect(await screen.findByText("Server not bound")).toBeInTheDocument();
  });
});
