import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingComposerInsertsForTest,
  requestComposerInsert,
  subscribeComposerInsert,
} from "./composer-insert";

beforeEach(clearPendingComposerInsertsForTest);

describe("composer insert channel", () => {
  it("delivers an insert to a mounted Composer", () => {
    const handler = vi.fn(() => true);
    const unsubscribe = subscribeComposerInsert(handler);
    requestComposerInsert("@src/App.tsx");
    expect(handler).toHaveBeenCalledWith("@src/App.tsx");
    unsubscribe();
  });

  it("retains an insert until a Composer can consume it", () => {
    requestComposerInsert("@README.md");
    const handler = vi.fn(() => true);
    const unsubscribe = subscribeComposerInsert(handler);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("@README.md");
    unsubscribe();
  });
});
