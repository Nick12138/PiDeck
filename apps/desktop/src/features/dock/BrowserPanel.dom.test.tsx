/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => mocks.unlisten),
}));

import { BrowserPanel } from "./BrowserPanel";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 100,
    y: 80,
    top: 80,
    left: 100,
    right: 500,
    bottom: 380,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "browser_surface_create") {
      return { surfaceId: "dock-browser-7", url: "about:blank" };
    }
    if (command === "browser_surface_navigate") return "https://example.com/";
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("BrowserPanel native lifecycle", () => {
  it("creates lazily, hides behind overlays, navigates, and closes", async () => {
    const user = userEvent.setup();
    const onTitle = vi.fn();
    const view = render(
      <BrowserPanel id={7} visible={false} blocked={false} onTitle={onTitle} />,
    );
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "browser_surface_create",
      expect.anything(),
    );

    view.rerender(<BrowserPanel id={7} visible blocked={false} onTitle={onTitle} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "browser_surface_create",
        expect.objectContaining({
          surfaceId: "dock-browser-7",
          visible: true,
          bounds: { x: 100, y: 80, width: 400, height: 300 },
        }),
      ),
    );

    await user.type(screen.getByRole("textbox", { name: "Browser address" }), "example.com{Enter}");
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_navigate", {
        surfaceId: "dock-browser-7",
        url: "https://example.com",
      }),
    );

    view.rerender(<BrowserPanel id={7} visible blocked onTitle={onTitle} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_set_visible", {
        surfaceId: "dock-browser-7",
        visible: false,
      }),
    );

    view.unmount();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("browser_surface_close", {
        surfaceId: "dock-browser-7",
      }),
    );
  });
});
