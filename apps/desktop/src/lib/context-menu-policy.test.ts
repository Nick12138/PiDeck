/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { shouldKeepNativeContextMenu } from "./context-menu-policy";

describe("native context-menu exceptions", () => {
  it("preserves drag-region and development Shift menus only", () => {
    const dragRegion = document.createElement("div");
    dragRegion.dataset.tauriDragRegion = "";
    const child = document.createElement("span");
    dragRegion.append(child);
    expect(shouldKeepNativeContextMenu({ target: child, shiftKey: false }, false)).toBe(true);
    expect(shouldKeepNativeContextMenu({ target: document.body, shiftKey: true }, true)).toBe(true);
    expect(shouldKeepNativeContextMenu({ target: document.body, shiftKey: true }, false)).toBe(false);
    expect(shouldKeepNativeContextMenu({ target: document.body, shiftKey: false }, true)).toBe(false);
  });
});
