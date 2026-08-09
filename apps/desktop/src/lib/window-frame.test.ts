import { describe, expect, it } from "vitest";
import { resolveWindowFrameAttribute, resolveWindowFrameMode } from "./window-frame";

describe("resolveWindowFrameMode", () => {
  it("keeps the rounded floating frame for a normal window", () => {
    expect(resolveWindowFrameMode(false, false)).toBe("floating");
  });

  it("fills the screen when maximized or fullscreen", () => {
    expect(resolveWindowFrameMode(true, false)).toBe("filled");
    expect(resolveWindowFrameMode(false, true)).toBe("filled");
    expect(resolveWindowFrameMode(true, true)).toBe("filled");
  });

  it("exposes frame state only inside a native desktop window", () => {
    expect(resolveWindowFrameAttribute(true, "floating")).toBe("floating");
    expect(resolveWindowFrameAttribute(true, "filled")).toBe("filled");
    expect(resolveWindowFrameAttribute(false, "floating")).toBeUndefined();
  });
});
