import { describe, expect, it } from "vitest";
import { busySendMethod } from "./busy-send";

describe("busySendMethod", () => {
  it("uses follow-up by default", () => {
    expect(busySendMethod(undefined)).toBe("agent.followUp");
  });

  it("uses follow-up when explicitly selected", () => {
    expect(busySendMethod("followUp")).toBe("agent.followUp");
  });

  it("uses steer for immediate current-turn guidance", () => {
    expect(busySendMethod("steer")).toBe("agent.steer");
  });
});
