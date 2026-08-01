/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAppStore } from "../stores/app-store";
import { appCommands } from "./registry";
import { ShortcutReference } from "./ShortcutReference";

afterEach(() => {
  cleanup();
  useAppStore.getState().setDesktopSettings(null);
});

describe("ShortcutReference", () => {
  it("renders every registered chord with macOS key labels", () => {
    useAppStore.getState().setDesktopSettings({ language: "en" } as never);
    const { container } = render(<ShortcutReference isMac />);

    expect(container.querySelectorAll("kbd")).toHaveLength(
      appCommands.filter((command) => command.chord).length,
    );
    expect(screen.getByText("⌘N")).toBeInTheDocument();
    expect(screen.getByText("Esc")).toBeInTheDocument();
  });

  it("uses the current locale and non-macOS modifier labels", () => {
    useAppStore.getState().setDesktopSettings({
      language: "zh",
      shortcutOverrides: {
        "session.new": "mod+shift+n",
        "chat.stop": null,
      },
    } as never);
    render(<ShortcutReference isMac={false} />);

    expect(screen.getByText("新建会话")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Shift+N")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+/")).toBeInTheDocument();
    expect(screen.getByText("未设置")).toBeInTheDocument();
  });
});
