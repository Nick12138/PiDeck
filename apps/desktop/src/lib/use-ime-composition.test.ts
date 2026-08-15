import { describe, expect, it } from "vitest";
import { isImeKeyEvent, type ImeCompositionState } from "./use-ime-composition";

const idle: ImeCompositionState = { composing: false, endedAt: Number.NEGATIVE_INFINITY };

describe("isImeKeyEvent", () => {
  it("passes ordinary keys through", () => {
    expect(isImeKeyEvent({ timeStamp: 1000, keyCode: 13 }, idle)).toBe(false);
  });

  it("blocks keys while a composition is active", () => {
    expect(isImeKeyEvent({ timeStamp: 1000 }, { ...idle, composing: true })).toBe(true);
    expect(isImeKeyEvent({ timeStamp: 1000, nativeEvent: { isComposing: true } }, idle)).toBe(true);
    expect(isImeKeyEvent({ timeStamp: 1000, keyCode: 229 }, idle)).toBe(true);
  });

  it("blocks the WebKit commit key that lands right after compositionend", () => {
    expect(
      isImeKeyEvent({ timeStamp: 1002, keyCode: 13 }, { composing: false, endedAt: 1000 }),
    ).toBe(true);
  });

  it("passes a deliberate Enter pressed well after the composition ended", () => {
    expect(
      isImeKeyEvent({ timeStamp: 1200, keyCode: 13 }, { composing: false, endedAt: 1000 }),
    ).toBe(false);
  });
});
