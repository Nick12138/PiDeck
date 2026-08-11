import { describe, expect, it } from "vitest";
import { draftKeyForTarget, draftTargetFor } from "./draft-target";

describe("draft targets", () => {
  it("uses a canonical workspace key for a pristine conversation", () => {
    const target = draftTargetFor(
      { canonicalCwd: "/repo" },
      { sessionId: "transient", messages: [] },
    );
    expect(target).toEqual({ kind: "new-conversation", canonicalCwd: "/repo" });
    expect(draftKeyForTarget(target!)).toBe("new:/repo");
  });

  it("uses the stable Session ID after history exists", () => {
    const target = draftTargetFor(
      { canonicalCwd: "/repo" },
      { sessionId: "s1", messages: [{ role: "user", content: "hello" }] },
    );
    expect(target).toEqual({ kind: "session", canonicalCwd: "/repo", sessionId: "s1" });
    expect(draftKeyForTarget(target!)).toBe("session:s1");
  });

  it("returns no target before workspace and Session hydration", () => {
    expect(draftTargetFor(null, null)).toBeNull();
  });
});
