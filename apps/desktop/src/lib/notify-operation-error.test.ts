import { describe, expect, it } from "vitest";
import { HostEpochError } from "./bridge/host-client";
import { notifyOperationFailure, userErrorMessage } from "./notify-operation-error";
import { useAppStore } from "./stores/app-store";

describe("notifyOperationFailure", () => {
  it("suppresses host-epoch rejections so internal reasons never enter notifications", () => {
    const before = useAppStore.getState().notifications.length;
    const beforeTransient = useAppStore.getState().transientNotifications.length;

    const pushed = notifyOperationFailure(new HostEpochError("bootstrap hello"), "Fallback");

    expect(pushed).toBe(false);
    expect(useAppStore.getState().notifications).toHaveLength(before);
    expect(useAppStore.getState().transientNotifications).toHaveLength(beforeTransient);
  });

  it("pushes the real error message for ordinary failures", () => {
    const pushed = notifyOperationFailure(new Error("disk full"), "Fallback");

    expect(pushed).toBe(true);
    expect(useAppStore.getState().notifications.at(-1)?.message).toBe("disk full");
  });

  it("falls back when the thrown value is not an Error", () => {
    const pushed = notifyOperationFailure("weird", "Fallback");

    expect(pushed).toBe(true);
    expect(useAppStore.getState().notifications.at(-1)?.message).toBe("Fallback");
  });
});

describe("userErrorMessage", () => {
  it("collapses host-epoch reasons to the fallback", () => {
    expect(userErrorMessage(new HostEpochError("bootstrap hello"), "Load failed")).toBe(
      "Load failed",
    );
  });

  it("keeps real error messages", () => {
    expect(userErrorMessage(new Error("network down"), "Load failed")).toBe("network down");
    expect(userErrorMessage("weird", "Load failed")).toBe("Load failed");
  });
});
