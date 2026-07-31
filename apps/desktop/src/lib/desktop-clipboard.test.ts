/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readClipboardText } from "./desktop-clipboard";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  readNativeText: vi.fn(),
  readWebText: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: mocks.readNativeText,
}));

beforeEach(() => {
  mocks.isTauri.mockReset();
  mocks.readNativeText.mockReset();
  mocks.readWebText.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: mocks.readWebText },
  });
});

describe("readClipboardText", () => {
  it("uses the native clipboard in Tauri", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.readNativeText.mockResolvedValue("native text");

    await expect(readClipboardText()).resolves.toBe("native text");

    expect(mocks.readNativeText).toHaveBeenCalledOnce();
    expect(mocks.readWebText).not.toHaveBeenCalled();
  });

  it("uses the Web Clipboard API outside Tauri", async () => {
    mocks.isTauri.mockReturnValue(false);
    mocks.readWebText.mockResolvedValue("browser text");

    await expect(readClipboardText()).resolves.toBe("browser text");

    expect(mocks.readWebText).toHaveBeenCalledOnce();
    expect(mocks.readNativeText).not.toHaveBeenCalled();
  });

  it("does not trigger a Web Clipboard prompt after a native read failure", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.readNativeText.mockRejectedValue(new Error("clipboard unavailable"));

    await expect(readClipboardText()).rejects.toThrow("clipboard unavailable");

    expect(mocks.readWebText).not.toHaveBeenCalled();
  });
});
