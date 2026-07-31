import { beforeEach, describe, expect, it, vi } from "vitest";

import { HostClient } from "./host-client";
import { createTauriTransport } from "./tauri-transport";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

describe("createTauriTransport", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.isTauri.mockReset();
    mocks.listen.mockReset();
  });

  it("provides a protocol-valid browser hello response", async () => {
    mocks.isTauri.mockReturnValue(false);
    const client = new HostClient();
    client.attach(await createTauriTransport());

    await expect(client.hello()).resolves.toMatchObject({
      hostInstanceId: "00000000-0000-4000-8000-000000000004",
      nodeVersion: "browser",
    });
    expect(mocks.listen).not.toHaveBeenCalled();

    client.detach();
  });

  it("propagates native listener initialization failures", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.listen.mockRejectedValueOnce(new Error("event listener unavailable"));

    await expect(createTauriTransport()).rejects.toThrow("event listener unavailable");
  });
});
