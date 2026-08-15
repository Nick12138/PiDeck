import { describe, expect, it } from "vitest";
import { summarizeHostFailure } from "./host-failure-message.js";

describe("summarizeHostFailure", () => {
  it("uses the final structured stderr error without exposing its stack", () => {
    const message = [
      "Pi Host exited (exit status: 1). stderr: " +
        JSON.stringify({ level: "info", message: "Pi Host ready" }),
      JSON.stringify({
        level: "error",
        message: "Uncaught exception in Pi Host",
        meta: {
          error:
            "This extension ctx is stale after session replacement or reload. Do not reuse it.",
          stack: "very long stack",
        },
      }),
    ].join(" | ");

    expect(summarizeHostFailure(message)).toBe(
      "Pi Host exited (exit status: 1): This extension ctx is stale after session replacement or reload.",
    );
  });

  it("bounds unstructured native failures", () => {
    const summary = summarizeHostFailure(`unexpected ${"x".repeat(400)}`, 80);
    expect(summary).toHaveLength(80);
    expect(summary.endsWith("...")).toBe(true);
  });
});
