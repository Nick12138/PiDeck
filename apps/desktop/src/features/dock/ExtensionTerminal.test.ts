import { afterEach, describe, expect, it, vi } from "vitest";
import { hostClient } from "../../lib/bridge/host-client";
import {
  useAppStore,
  type ExtensionTerminalState,
} from "../../lib/stores/app-store";
import { cancelExtensionTerminal, forceCloseExtensionTerminal } from "./ExtensionTerminal";

const panel: ExtensionTerminalState = {
  requestId: "00000000-0000-4000-8000-000000000001",
  title: "Extension",
  cols: 100,
  rows: 32,
  context: {
    expectedHostInstanceId: "10000000-0000-4000-8000-000000000001",
    expectedWorkspaceId: "20000000-0000-4000-8000-000000000001",
    expectedWorkspaceRevision: 1,
    expectedSessionId: "30000000-0000-4000-8000-000000000001",
    expectedSessionRevision: 1,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cancelExtensionTerminal", () => {
  it("sends Escape only to the extension virtual terminal", async () => {
    const close = vi.spyOn(useAppStore.getState(), "closeExtensionTerminal");
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: { accepted: true },
    } as never);

    await expect(cancelExtensionTerminal(panel)).resolves.toBeNull();
    expect(request).toHaveBeenCalledWith(
      "extensionUi.customInput",
      panel.context,
      { requestId: panel.requestId, data: "\u001b" },
    );
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps the panel visible when cancellation is rejected", async () => {
    const close = vi.spyOn(useAppStore.getState(), "closeExtensionTerminal");
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: false,
      error: { message: "Panel is still active" },
    } as never);

    await expect(cancelExtensionTerminal(panel)).resolves.toBe("Panel is still active");
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps the panel visible when cancellation throws", async () => {
    const close = vi.spyOn(useAppStore.getState(), "closeExtensionTerminal");
    vi.spyOn(hostClient, "request").mockRejectedValue(new Error("Host unavailable"));

    await expect(cancelExtensionTerminal(panel)).resolves.toBe("Host unavailable");
    expect(close).not.toHaveBeenCalled();
  });
});

describe("forceCloseExtensionTerminal", () => {
  it("cancels the pending ui.custom() request host-side", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: { accepted: true },
    } as never);

    await expect(forceCloseExtensionTerminal(panel)).resolves.toBeNull();
    expect(request).toHaveBeenCalledWith(
      "extensionUi.respond",
      panel.context,
      { requestId: panel.requestId, status: "cancelled" },
    );
  });

  it("returns the host error when the request is rejected", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: false,
      error: { message: "Unknown, expired, or stale Extension UI requestId" },
    } as never);

    await expect(forceCloseExtensionTerminal(panel)).resolves.toBe(
      "Unknown, expired, or stale Extension UI requestId",
    );
  });

  it("returns the transport error when the request throws", async () => {
    vi.spyOn(hostClient, "request").mockRejectedValue(new Error("Host unavailable"));

    await expect(forceCloseExtensionTerminal(panel)).resolves.toBe("Host unavailable");
  });
});
