import { describe, expect, it, vi } from "vitest";
import {
  requestSessionSearchFocus,
  subscribeSessionSearchFocus,
} from "./events";

describe("session search command bus", () => {
  it("queues focus until the collapsed Sidebar remounts SessionList", () => {
    expect(requestSessionSearchFocus()).toBe(false);
    const handler = vi.fn();
    const unsubscribe = subscribeSessionSearchFocus(handler);
    expect(handler).toHaveBeenCalledOnce();
    expect(requestSessionSearchFocus()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
