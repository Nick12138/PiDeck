import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingChangesPanelForTest,
  requestChangesPanel,
  subscribeChangesPanel,
} from "./dock-changes";

afterEach(() => clearPendingChangesPanelForTest());

describe("dock Changes bridge", () => {
  it("delivers queued requests to the first subscriber", () => {
    requestChangesPanel();
    const handler = vi.fn(() => true);
    const unsubscribe = subscribeChangesPanel(handler);
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not retain handlers after unsubscribe", () => {
    const handler = vi.fn(() => true);
    const unsubscribe = subscribeChangesPanel(handler);
    unsubscribe();
    requestChangesPanel();
    expect(handler).not.toHaveBeenCalled();
  });
});
