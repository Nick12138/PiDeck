import { describe, expect, it } from "vitest";
import { normalizeBrowserInput } from "./BrowserPanel";

describe("normalizeBrowserInput", () => {
  it("keeps explicit URLs for native validation", () => {
    expect(normalizeBrowserInput("https://example.com/path")).toBe("https://example.com/path");
    expect(normalizeBrowserInput("file:///tmp/example")).toBe("file:///tmp/example");
  });

  it("adds https to host-like input", () => {
    expect(normalizeBrowserInput("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeBrowserInput("localhost:5173")).toBe("http://localhost:5173");
  });

  it("turns other text into a search and keeps blank as the empty page", () => {
    expect(normalizeBrowserInput("native webview security")).toBe(
      "https://www.google.com/search?q=native%20webview%20security",
    );
    expect(normalizeBrowserInput("   ")).toBe("about:blank");
  });
});
