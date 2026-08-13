import { describe, expect, it, vi } from "vitest";
import { requestGlobalSearchOpen, subscribeGlobalSearchOpen } from "./events";

describe("global search command bus", () => {
  it("notifies the subscribed handler and stops after unsubscribe", () => {
    const handler = vi.fn();
    requestGlobalSearchOpen();
    expect(handler).not.toHaveBeenCalled();

    const unsubscribe = subscribeGlobalSearchOpen(handler);
    requestGlobalSearchOpen();
    expect(handler).toHaveBeenCalledOnce();

    unsubscribe();
    requestGlobalSearchOpen();
    expect(handler).toHaveBeenCalledOnce();
  });
});
