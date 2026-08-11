import { describe, expect, it } from "vitest";
import { shouldAwaitDraftFlushOnClose } from "./DraftPersistenceController";

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
