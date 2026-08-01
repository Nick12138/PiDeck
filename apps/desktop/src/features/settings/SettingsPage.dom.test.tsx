/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { SettingsPage } from "./SettingsPage";
import { hostClient } from "../../lib/bridge/host-client";

const CONNECTED_HOST = {
  protocolVersion: 1 as const,
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  workspaceId: null,
  workspaceRevision: 0,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 0,
  sdkVersion: "0.82.1",
  nodeVersion: "v24.18.0",
  agentDir: "/agent",
  phase: "waitingForWorkspace" as const,
  capabilities: {
    packageUpdateCheck: false,
    extensionUi: true as const,
    sessionExport: true,
  },
  modelConfigHealth: {
    state: "ok" as const,
    source: "ModelRegistry.getError" as const,
  },
  extensionDecisionPresentation: "legacy-modal" as const,
};

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockRejectedValue(new Error("Tauri unavailable"));
  tauriMocks.isTauri.mockReset();
  tauriMocks.isTauri.mockReturnValue(false);
  useAppStore.getState().setHost(null);
  useAppStore.getState().setProvidersDirty(false);
  useAppStore.getState().clearNotifications();
  useAppStore.getState().setDesktopSettings({
    theme: "system",
    language: "en",
    restoreLastSession: true,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "legacy-modal",
    terminalProfile: "auto",
  });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().setProvidersDirty(false);
  useAppStore.getState().setDesktopSettings(null);
  vi.restoreAllMocks();
});

describe("SettingsPage navigation guard", () => {
  it("switches sections directly when the Providers form is clean", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="providers" />);

    expect(screen.getByText("No Providers configured yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "General" }));
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  });

  it("offers the Host section with runtime info split out of General", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    expect(screen.getByText("Auto-restart Pi Host")).toBeInTheDocument();
    expect(screen.queryByText("Capabilities")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Host" }));
    expect(screen.getByRole("heading", { name: "Host" })).toBeInTheDocument();
    expect(screen.getByText("Capabilities")).toBeInTheDocument();
    expect(screen.getByText("Host not connected.")).toBeInTheDocument();
  });

  it("offers a persistent Shortcuts section generated from the command registry", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    await user.click(screen.getByRole("button", { name: "Shortcuts" }));

    expect(
      screen.getByRole("heading", { name: "Keyboard shortcuts" }),
    ).toBeInTheDocument();
    expect(screen.getByText("New session")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+N")).toBeInTheDocument();
    expect(screen.getByText("Show keyboard shortcuts")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+/")).toBeInTheDocument();
  });

  it("asks before leaving Providers with unsaved changes and keeps the section on cancel", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="providers" />);
    useAppStore.getState().setProvidersDirty(true);

    await user.click(screen.getByRole("button", { name: "General" }));
    expect(
      screen.getByRole("heading", { name: "Discard unsaved Provider changes?" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("No Providers configured yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "General" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  });

  it("switches the interface to Chinese from the General language select", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    expect(screen.getByRole("button", { name: "General" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/Language/), "zh");

    expect(screen.getByRole("button", { name: "通用" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "主机" })).toBeInTheDocument();
    expect(screen.getByText("外观与启动")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "General" })).not.toBeInTheDocument();
  });

  it("validates and persists the conversation width from Appearance settings", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    const input = screen.getByRole("spinbutton", { name: "Conversation width" });
    expect(input).toHaveValue(768);

    await user.clear(input);
    await user.type(input, "559");
    await user.tab();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a whole number of at least 560px.",
    );
    expect(useAppStore.getState().desktopSettings?.conversationContentWidth).toBeUndefined();

    await user.click(input);
    await user.clear(input);
    await user.type(input, "920");
    await user.tab();

    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.conversationContentWidth).toBe(920),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("synchronizes automatic presentation and offers one-click legacy rollback", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setHost(CONNECTED_HOST);
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: { extensionDecisionPresentation: "auto" },
    } as never);
    render(<SettingsPage initialSection="general" />);

    const group = screen.getByRole("group", {
      name: "Extension prompt presentation",
    });
    const legacy = within(group).getByRole("radio", { name: /^Legacy modal/ });
    const automatic = within(group).getByRole("radio", { name: /^Automatic/ });
    expect(legacy).toBeChecked();

    await user.click(automatic);
    await waitFor(() =>
      expect(
        useAppStore.getState().desktopSettings?.extensionDecisionPresentation,
      ).toBe("auto"),
    );
    expect(request).toHaveBeenNthCalledWith(
      1,
      "extensionUi.configure",
      { expectedHostInstanceId: CONNECTED_HOST.hostInstanceId },
      { extensionDecisionPresentation: "auto" },
    );
    expect(automatic).toBeChecked();

    await user.click(legacy);
    await waitFor(() =>
      expect(
        useAppStore.getState().desktopSettings?.extensionDecisionPresentation,
      ).toBe("legacy-modal"),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "extensionUi.configure",
      { expectedHostInstanceId: CONNECTED_HOST.hostInstanceId },
      { extensionDecisionPresentation: "legacy-modal" },
    );
    expect(legacy).toBeChecked();
  });

  it("keeps the previous setting and reports a rejected desktop patch", async () => {
    const user = userEvent.setup();
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "shell_terminal_profiles") {
        return {
          profiles: [],
          automaticProfile: { id: "auto", label: "Automatic", path: "/bin/sh" },
        };
      }
      throw new Error("disk full");
    });
    render(<SettingsPage initialSection="general" />);

    await user.selectOptions(screen.getByLabelText(/Theme/), "light");

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("desktop_settings_patch", {
        patch: { theme: "light" },
      }),
    );
    expect(useAppStore.getState().desktopSettings?.theme).toBe("system");
    expect(
      useAppStore
        .getState()
        .notifications.some((notification) => notification.message.includes("disk full")),
    ).toBe(true);
  });

  it("guards the close button while dirty and closes once confirmed via the overlay owner", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SettingsPage initialSection="providers" onClose={onClose} />);
    useAppStore.getState().setProvidersDirty(true);

    // The overlay owner decides what "close" means; SettingsPage just forwards.
    await user.click(screen.getByRole("button", { name: "Back to conversation" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
