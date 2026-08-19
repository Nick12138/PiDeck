/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WindowControls,
  resolveWindowControlsPlatform,
  shouldRenderWindowControls,
} from "./WindowControls";

const windowApi = vi.hoisted(() => ({
  minimize: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowApi,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("resolveWindowControlsPlatform", () => {
  it("prefers the Tauri build platform and falls back to the browser user agent", () => {
    expect(resolveWindowControlsPlatform("darwin", "Windows")).toBe("macos");
    expect(resolveWindowControlsPlatform("macos", "Windows")).toBe("macos");
    expect(resolveWindowControlsPlatform("windows", "Macintosh")).toBe("windows");
    expect(resolveWindowControlsPlatform(undefined, "Mozilla/5.0 (Macintosh)")).toBe("macos");
    expect(resolveWindowControlsPlatform(undefined, "Mozilla/5.0 (Windows NT 10.0)")).toBe(
      "windows",
    );
  });
});

describe("shouldRenderWindowControls", () => {
  it("hides only macOS traffic lights while the settings overlay is open", () => {
    expect(shouldRenderWindowControls("macos", true)).toBe(false);
    expect(shouldRenderWindowControls("macos", false)).toBe(true);
    expect(shouldRenderWindowControls("windows", true)).toBe(true);
    expect(shouldRenderWindowControls("windows", false)).toBe(true);
  });
});

describe("WindowControls", () => {
  it("renders macOS traffic lights inline for the app top bar in native action order", () => {
    render(<WindowControls platform="macos" />);

    const controls = screen.getByRole("group", { name: "Window controls" });
    expect(controls).toHaveAttribute("data-window-controls-platform", "macos");
    // Traffic lights are now inlined inside AppTopBar's left segment instead of
    // an absolute floating layer — assert the inline flex group carries no
    // positioning classes.
    expect(controls).toHaveClass("mac-window-controls", "flex", "shrink-0", "items-center");
    expect(controls).not.toHaveClass("absolute", "left-1.5", "top-1.5", "z-50");
    expect(
      within(controls)
        .getAllByRole("button")
        .map((button) => button.ariaLabel),
    ).toEqual(["Close window", "Minimize window", "Maximize or restore window"]);
    expect(
      within(controls).getByRole("button", { name: "Close window" }).firstElementChild,
    ).toHaveClass("mac-window-control-dot--close");
    expect(
      within(controls).getByRole("button", { name: "Minimize window" }).firstElementChild,
    ).toHaveClass("mac-window-control-dot--minimize");
    expect(
      within(controls).getByRole("button", { name: "Maximize or restore window" })
        .firstElementChild,
    ).toHaveClass("mac-window-control-dot--maximize");
  });

  it("aligns the Windows controls with the app top bar in native action order", () => {
    render(<WindowControls platform="windows" />);

    const controls = screen.getByRole("group", { name: "Window controls" });
    expect(controls).toHaveAttribute("data-window-controls-platform", "windows");
    // Windows controls are now inlined at the right end of AppTopBar instead of
    // an absolute floating layer.
    expect(controls).toHaveClass("flex", "shrink-0", "items-center");
    expect(controls).not.toHaveClass("absolute", "right-0", "top-0", "z-50");
    const buttons = within(controls).getAllByRole("button");
    expect(buttons.map((button) => button.ariaLabel)).toEqual([
      "Minimize window",
      "Maximize or restore window",
      "Close window",
    ]);
    expect(
      buttons.every((button) => button.classList.contains("h-[var(--theme-toolbar-height)]")),
    ).toBe(true);
  });

  it("routes macOS traffic-light clicks through the shared Tauri window actions", async () => {
    const user = userEvent.setup();
    render(<WindowControls platform="macos" />);

    await user.click(screen.getByRole("button", { name: "Close window" }));
    await user.click(screen.getByRole("button", { name: "Minimize window" }));
    await user.click(screen.getByRole("button", { name: "Maximize or restore window" }));

    await waitFor(() => {
      expect(windowApi.close).toHaveBeenCalledOnce();
      expect(windowApi.minimize).toHaveBeenCalledOnce();
      expect(windowApi.toggleMaximize).toHaveBeenCalledOnce();
    });
  });
});
