import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestDockBrowser: vi.fn(),
  openSystemUrl: vi.fn(),
}));

vi.mock("../../lib/dock-browser", () => ({
  requestDockBrowser: mocks.requestDockBrowser,
}));
vi.mock("../../lib/open-system-url", () => ({
  openSystemUrl: mocks.openSystemUrl,
}));

import { openChatLink, usesSystemBrowser } from "./chat-link";

beforeEach(() => {
  mocks.requestDockBrowser.mockReset().mockReturnValue(true);
  mocks.openSystemUrl.mockReset().mockResolvedValue(undefined);
});

describe("chat link routing", () => {
  it("opens an unmodified safe link in the Dock", () => {
    expect(openChatLink("https://example.com/path", { button: 0 })).toBe(true);
    expect(mocks.requestDockBrowser).toHaveBeenCalledWith({
      url: "https://example.com/path",
    });
    expect(mocks.openSystemUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["meta", { metaKey: true }],
    ["control", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["middle click", { button: 1 }],
  ])("uses the system browser for %s activation", (_label, activation) => {
    expect(usesSystemBrowser(activation)).toBe(true);
    expect(openChatLink("https://example.com/system", activation)).toBe(true);
    expect(mocks.requestDockBrowser).not.toHaveBeenCalled();
    expect(mocks.openSystemUrl).toHaveBeenCalledWith("https://example.com/system");
  });

  it("falls back to the system browser when the Dock refuses the request", () => {
    mocks.requestDockBrowser.mockReturnValue(false);

    expect(openChatLink("https://example.com/ninth")).toBe(true);
    expect(mocks.openSystemUrl).toHaveBeenCalledWith("https://example.com/ninth");
  });

  it("rejects unsafe URLs without invoking either destination", () => {
    expect(openChatLink("file:///tmp/private")).toBe(false);
    expect(openChatLink("javascript:alert(1)")).toBe(false);
    expect(mocks.requestDockBrowser).not.toHaveBeenCalled();
    expect(mocks.openSystemUrl).not.toHaveBeenCalled();
  });
});
