/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, SessionSummary, WorkspaceSnapshot } from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { closeContextMenu } from "../../lib/context-menu";
import { MenuHost } from "../../components/Menu";
import { SessionList } from "./SessionList";

const summary: SessionSummary = {
  sessionId: "session-1",
  sessionPath: "/sessions/session-1.jsonl",
  name: "Position the menu",
  cwd: "/workspace",
  updatedAt: 1,
  messageCount: 1,
};

const host: HostStatusSnapshot = {
  protocolVersion: 1,
  hostInstanceId: "host-1",
  workspaceId: "workspace-1",
  workspaceRevision: 1,
  sessionId: null,
  sessionRevision: 0,
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

const workspace: WorkspaceSnapshot = {
  id: "workspace-1",
  cwd: "/workspace",
  canonicalCwd: "/workspace",
  revision: 1,
  servicesReady: true,
};

describe("SessionList actions", () => {
  beforeEach(() => {
    useAppStore.setState({
      host,
      workspace,
      session: null,
      connecting: false,
      rehydrating: false,
      desynchronized: false,
      hostFatal: null,
    });
    useAppStore.getState().replaceSessionCatalog(workspace.id, [summary]);
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: { items: [summary] },
    } as never);
  });

  afterEach(() => {
    closeContextMenu();
    cleanup();
    vi.restoreAllMocks();
  });

  it("archives the session directly when the archive button is clicked", async () => {
    render(<SessionList />);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => {
      expect(hostClient.request).toHaveBeenCalledWith(
        "session.archive",
        expect.anything(),
        { sessionId: "session-1", sessionPath: "/sessions/session-1.jsonl" },
      );
    });
  });

  it("exposes reload and archive in the session context menu", async () => {
    render(
      <>
        <MenuHost />
        <SessionList />
      </>,
    );
    fireEvent.contextMenu(screen.getByText("Position the menu"));

    expect(await screen.findByRole("menuitem", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
  });
});
