import { describe, expect, it } from "vitest";
import {
  closeWindowAfterDraftFlush,
  shouldAwaitDraftFlushOnClose,
} from "./DraftPersistenceController";

describe("shouldAwaitDraftFlushOnClose", () => {
  it("leaves Windows close-to-tray behavior to the native shell", () => {
    expect(shouldAwaitDraftFlushOnClose("windows", "Macintosh")).toBe(false);
    expect(shouldAwaitDraftFlushOnClose("win32", "Macintosh")).toBe(false);
  });

  it("waits briefly before destroying macOS and Linux windows", () => {
    expect(shouldAwaitDraftFlushOnClose("darwin", "Windows NT 10.0")).toBe(true);
    expect(shouldAwaitDraftFlushOnClose("linux", "Windows NT 10.0")).toBe(true);
  });

  it("falls back to the user agent when Tauri platform metadata is unavailable", () => {
    expect(shouldAwaitDraftFlushOnClose(undefined, "Windows NT 10.0")).toBe(false);
    expect(shouldAwaitDraftFlushOnClose(undefined, "Macintosh")).toBe(true);
  });
});

describe("closeWindowAfterDraftFlush", () => {
  it("hides the window before settling drafts and destroying it", async () => {
    const calls: string[] = [];

    await closeWindowAfterDraftFlush(
      { preventDefault: () => calls.push("prevent") },
      {
        hide: async () => {
          calls.push("hide");
        },
        destroy: async () => {
          calls.push("destroy");
        },
      },
      async () => {
        calls.push("settle");
      },
    );

    expect(calls).toEqual(["prevent", "hide", "settle", "destroy"]);
  });

  it("still settles drafts and destroys the window when hiding fails", async () => {
    const calls: string[] = [];

    await closeWindowAfterDraftFlush(
      { preventDefault: () => calls.push("prevent") },
      {
        hide: async () => {
          calls.push("hide");
          throw new Error("hide failed");
        },
        destroy: async () => {
          calls.push("destroy");
        },
      },
      async () => {
        calls.push("settle");
      },
    );

    expect(calls).toEqual(["prevent", "hide", "settle", "destroy"]);
  });
});
