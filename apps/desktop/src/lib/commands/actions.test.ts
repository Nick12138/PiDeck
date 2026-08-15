import { describe, expect, it } from "vitest";
import { abortMethodForSession } from "./actions";

describe("abortMethodForSession", () => {
  it("routes each busy lifecycle to its matching Host method", () => {
    expect(abortMethodForSession({})).toBe("agent.abort");
    expect(abortMethodForSession({ isCompacting: true })).toBe("agent.abortCompaction");
    expect(abortMethodForSession({ isRetrying: true })).toBe("agent.abortRetry");
    expect(abortMethodForSession({ isCompacting: true, isRetrying: true })).toBe(
      "agent.abortCompaction",
    );
  });
});
