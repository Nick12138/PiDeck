/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { HostSettings } from "./HostSettings";

const invokeMock = vi.fn(async () => undefined);
const openMock = vi.fn<() => Promise<string | null>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [])),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: async () => "9.9.9",
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...(args as [])),
}));

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: "11111111-1111-4111-8111-111111111111",
    workspaceId: null,
    workspaceRevision: 0,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: "v24.18.0",
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: false,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

beforeEach(() => {
  invokeMock.mockClear();
  openMock.mockReset();
  useAppStore.getState().setHost(host());
  useAppStore.getState().clearNotifications();
  useAppStore.getState().setHostFatal(null);
});

afterEach(() => {
  cleanup();
  useAppStore.getState().setHost(null);
  vi.restoreAllMocks();
});

describe("HostSettings", () => {
  it("renders capabilities as human-readable states, covering every advertised key", () => {
    render(<HostSettings />);

    expect(screen.getByText("Package update checks")).toBeInTheDocument();
    expect(screen.getByText("Extension UI")).toBeInTheDocument();
    expect(screen.getByText("Session export")).toBeInTheDocument();
    expect(screen.getAllByText("Enabled")).toHaveLength(2);
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/packageUpdateCheck:/)).not.toBeInTheDocument();
  });

  it("shows the app version in the About block", async () => {
    render(<HostSettings />);
    expect(await screen.findByText("9.9.9")).toBeInTheDocument();
  });

  it("requires a confirmation before restarting the Host", async () => {
    const user = userEvent.setup();
    render(<HostSettings />);

    await user.click(screen.getByRole("button", { name: "Restart Host" }));
    const dialog = screen.getByRole("dialog", { name: "Restart Pi Host?" });
    expect(dialog).toHaveTextContent("Any running agent turn is stopped immediately");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(invokeMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Restart Host" }));
    const reopened = screen.getByRole("dialog", { name: "Restart Pi Host?" });
    await user.click(within(reopened).getByRole("button", { name: "Restart Host" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("pi_host_restart"));
  });

  it("changes the agent directory through the folder picker", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setDesktopSettings({
      theme: "dark",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      terminalProfile: "auto",
    });
    openMock.mockResolvedValue("/new/agent-dir");
    invokeMock.mockResolvedValueOnce({
      theme: "dark",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      terminalProfile: "auto",
      agentDir: "/new/agent-dir",
    } as never);

    render(<HostSettings />);
    await user.click(screen.getByRole("button", { name: "Change agent directory…" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("desktop_settings_patch", {
        patch: { agentDir: "/new/agent-dir" },
      }),
    );
    expect(
      useAppStore
        .getState()
        .notifications.some((item) =>
          item.message.includes("restart Pi Host to apply"),
        ),
    ).toBe(true);
  });
});
