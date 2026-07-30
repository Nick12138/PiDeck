/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { requestDockBrowser, subscribeDockBrowser } from "./dock-browser";

function setDesktopRuntime(): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("Dock browser requests", () => {
  it("rejects non-desktop and unsafe requests before notifying handlers", () => {
    const handler = vi.fn(() => true);
    const unsubscribe = subscribeDockBrowser(handler);

    expect(requestDockBrowser({ url: "https://example.com" })).toBe(false);
    setDesktopRuntime();
    expect(requestDockBrowser({ url: "file:///tmp/private" })).toBe(false);
    expect(requestDockBrowser({ url: "javascript:alert(1)" })).toBe(false);
    expect(handler).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("returns whether a mounted Dock consumes the request", () => {
    setDesktopRuntime();
    const rejecting = vi.fn(() => false);
    const accepting = vi.fn(() => true);
    const unsubscribeRejecting = subscribeDockBrowser(rejecting);
    const unsubscribeAccepting = subscribeDockBrowser(accepting);

    expect(requestDockBrowser({ url: "https://example.com/path" })).toBe(true);
    expect(rejecting).toHaveBeenCalledWith({ url: "https://example.com/path" });
    expect(accepting).toHaveBeenCalledWith({ url: "https://example.com/path" });

    unsubscribeAccepting();
    expect(requestDockBrowser({ url: "https://example.com/after" })).toBe(false);
    unsubscribeRejecting();
    expect(requestDockBrowser({ url: "https://example.com/unmounted" })).toBe(false);
  });
});
