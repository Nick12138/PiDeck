/** @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import type { DesktopSettings, WorkspaceSnapshot } from "@pideck/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../lib/stores/app-store";
import { clearPendingTreePanelForTest, requestTreePanel } from "../lib/dock-tree";

vi.mock("../features/dock/ShellTerminal", () => ({
  ShellTerminal: ({ profileId, visible }: { profileId: string; visible: boolean }) => (
    <div data-testid="shell-terminal" data-profile={profileId} hidden={!visible} />
  ),
  shellTerminalLabel: (cwd: string) => cwd,
}));

vi.mock("../features/dock/ExtensionTerminal", () => ({
  ExtensionTerminal: () => null,
  cancelExtensionTerminal: vi.fn(async () => null),
}));

vi.mock("../features/dock/BrowserPanel", () => ({
  BrowserPanel: () => <div data-testid="browser-panel" />,
}));

import { RightDock } from "./RightDock";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

function settings(terminalProfile: string): DesktopSettings {
  return { terminalProfile } as DesktopSettings;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  useAppStore.setState({
    dockOpen: true,
    extensionTerminal: null,
    workspace: { canonicalCwd: "/workspace" } as WorkspaceSnapshot,
    desktopSettings: settings("auto"),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearPendingTreePanelForTest();
});

async function openAddMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "New dock page" }));
  return screen.getByRole("menu");
}

describe("RightDock pages", () => {
  it("starts without an active page", () => {
    render(<RightDock />);

    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByRole("button", { name: "Open Files" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Browser" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Terminal" })).toBeVisible();
  });

  it("opens each tool from the empty-state shortcuts", async () => {
    const user = userEvent.setup();
    render(<RightDock />);

    await user.click(screen.getByRole("button", { name: "Open Files" }));
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("button", { name: "Close Files" }));

    await user.click(screen.getByRole("button", { name: "Open Browser" }));
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Close Browser" }));

    await user.click(screen.getByRole("button", { name: "Open Terminal" }));
    expect(screen.getByRole("tab", { name: "Shell - /workspace" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("keeps the add menu inside the Dock as tabs appear", async () => {
    const user = userEvent.setup();
    render(<RightDock />);

    expect(await openAddMenu(user)).toHaveClass("left-0");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Open Files" }));
    expect(await openAddMenu(user)).toHaveClass("right-0");
  });

  it("keeps Files as a closable singleton", async () => {
    const user = userEvent.setup();
    render(<RightDock />);

    await openAddMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Files" }));
    await openAddMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Files" }));

    expect(screen.getAllByRole("tab", { name: "Files" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Close Files" }));
    expect(screen.queryByRole("tab", { name: "Files" })).toBeNull();
  });

  it("limits Browser pages to eight", async () => {
    const user = userEvent.setup();
    render(<RightDock />);

    for (let index = 0; index < 8; index += 1) {
      await openAddMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Browser" }));
    }
    await openAddMenu(user);

    expect(screen.getAllByRole("button", { name: "Close Browser" })).toHaveLength(8);
    expect(screen.getByRole("menuitem", { name: "Browser" })).toBeDisabled();
  });

  it("activates the adjacent page after closing the current page", async () => {
    const user = userEvent.setup();
    render(<RightDock />);

    await openAddMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Files" }));
    await openAddMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Browser" }));
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Close Browser" }));
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("captures the configured Shell profile when each Terminal is created", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ desktopSettings: settings("fish") });
    render(<RightDock />);

    await openAddMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));
    act(() => useAppStore.setState({ desktopSettings: settings("zsh") }));
    await openAddMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    await waitFor(() => {
      expect(screen.getAllByTestId("shell-terminal").map((node) => node.dataset.profile)).toEqual([
        "fish",
        "zsh",
      ]);
    });
  });

  it("supports keyboard navigation in the add menu", async () => {
    const user = userEvent.setup();
    render(<RightDock />);

    await openAddMenu(user);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Files" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Session tree" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Browser" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Terminal" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "New dock page" })).toHaveFocus();
  });

  it("opens the Tree page as a singleton via requestTreePanel", async () => {
    useAppStore.setState({ dockOpen: false });
    render(<RightDock />);

    act(() => requestTreePanel());
    expect(await screen.findByRole("tab", { name: "Tree" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(useAppStore.getState().dockOpen).toBe(true);

    act(() => requestTreePanel());
    expect(screen.getAllByRole("tab", { name: "Tree" })).toHaveLength(1);
  });
});
