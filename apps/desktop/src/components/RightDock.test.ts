import { describe, expect, it } from "vitest";
import {
  clampDockWidth,
  dockContentOverflow,
  partitionDockTabs,
  visibleDockTabLimit,
} from "./RightDock";

describe("clampDockWidth", () => {
  it("uses the configured desktop limits", () => {
    // The dock can be narrowed to MIN_DOCK_WIDTH (350); values below it clamp
    // up to 350 rather than to the default width.
    expect(clampDockWidth(300, 1280)).toBe(350);
    expect(clampDockWidth(350, 1280)).toBe(350);
    expect(clampDockWidth(460, 1280)).toBe(460);
    expect(clampDockWidth(520, 1280)).toBe(520);
    expect(clampDockWidth(900, 1280)).toBe(720);
  });

  it("keeps space for the main pane on a narrow window", () => {
    expect(clampDockWidth(720, 960)).toBe(600);
    expect(clampDockWidth(Number.NaN, 800)).toBe(460);
  });
});

describe("dock tab overflow", () => {
  it("shrinks all tabs until they reach the minimum width", () => {
    expect(visibleDockTabLimit(328, 3)).toBe(3);
    expect(visibleDockTabLimit(327, 3)).toBe(2);
  });

  it("reserves room for the overflow menu and new-tab button", () => {
    expect(visibleDockTabLimit(312, 4)).toBe(2);
    expect(visibleDockTabLimit(512, 5)).toBe(4);
  });

  it("keeps the active tab visible and moves another tab into the menu", () => {
    expect(partitionDockTabs(["a", "b", "c", "d"], "d", 2)).toEqual({
      visible: ["a", "d"],
      overflow: ["b", "c"],
    });
  });
});

describe("dockContentOverflow", () => {
  const elWithRight = (right: number): HTMLElement =>
    ({
      getBoundingClientRect: () =>
        ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          width: right,
          height: 0,
          right,
          bottom: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    }) as HTMLElement;

  it("is false when the chat page stays inside the main column", () => {
    expect(dockContentOverflow(elWithRight(100), elWithRight(90))).toBe(false);
  });

  it("is true when the chat page spills past the main column's right edge", () => {
    expect(dockContentOverflow(elWithRight(100), elWithRight(105))).toBe(true);
  });

  it("tolerates sub-pixel rounding at the boundary", () => {
    expect(dockContentOverflow(elWithRight(100), elWithRight(100.5))).toBe(false);
    expect(dockContentOverflow(elWithRight(100), elWithRight(101.5))).toBe(true);
  });

  it("is false while either element is missing", () => {
    expect(dockContentOverflow(null, elWithRight(10))).toBe(false);
    expect(dockContentOverflow(elWithRight(10), null)).toBe(false);
    expect(dockContentOverflow(null, null)).toBe(false);
  });
});
