import { describe, expect, it, vi } from "vitest";
import { requestDockPreview, subscribeDockPreview } from "./dock-preview";

describe("dock preview bus", () => {
  it("dispatches open requests to subscribed handlers", () => {
    const handler = vi.fn(() => true);
    const unsubscribe = subscribeDockPreview(handler);

    expect(requestDockPreview({ path: "src/app.ts" })).toBe(true);
    expect(handler).toHaveBeenCalledWith({ path: "src/app.ts" });

    unsubscribe();
    expect(requestDockPreview({ path: "src/app.ts" })).toBe(false);
  });

  it("returns false when no handler accepts the request", () => {
    expect(requestDockPreview({ path: "src/app.ts" })).toBe(false);
  });

  it("keeps dispatching when one handler throws", () => {
    const broken = vi.fn(() => {
      throw new Error("dock unmounted");
    });
    const healthy = vi.fn(() => true);
    subscribeDockPreview(broken);
    subscribeDockPreview(healthy);

    expect(requestDockPreview({ path: "src/app.ts" })).toBe(true);
    expect(healthy).toHaveBeenCalled();
  });
});
