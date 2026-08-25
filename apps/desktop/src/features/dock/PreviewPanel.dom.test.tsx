/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, WorkspaceSnapshot } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { PreviewPanel } from "./PreviewPanel";

vi.mock("../../lib/bridge/host-client", () => ({
  hostClient: { request: vi.fn() },
}));

vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="streamdown">{children}</div>
  ),
}));

const host = { hostInstanceId: "00000000-0000-4000-8000-000000000101" } as HostStatusSnapshot;
const workspace = {
  id: "00000000-0000-4000-8000-000000000201",
  revision: 3,
  canonicalCwd: "/repo/apps/desktop",
} as WorkspaceSnapshot;

const request = vi.mocked(hostClient.request);

beforeEach(() => {
  useAppStore.setState({ host, workspace });
});

afterEach(() => {
  cleanup();
  request.mockReset();
  useAppStore.setState({ host: null, workspace: null });
});

function okResult(result: unknown) {
  request.mockResolvedValue({ ok: true, result } as never);
}

describe("PreviewPanel", () => {
  it("requests the file through the host protocol and renders text", async () => {
    okResult({
      path: "src/hello.ts",
      kind: "text",
      size: 11,
      truncated: false,
      content: "export {};\n",
      encoding: "utf-8",
    });
    render(<PreviewPanel path="src/hello.ts" visible />);

    expect(await screen.findByText(/export \{\};\s*$/)).toBeInTheDocument();
    const code = screen.getByText(/export \{\};\s*$/);
    expect(code.tagName).toBe("PRE");
    expect(code.className).toContain("whitespace-pre-wrap");
    expect(code.className).toContain("break-words");
    expect(screen.getByText("hello.ts")).toBeInTheDocument();
    expect(screen.getByText(/11 B/)).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(
      "workspace.readFile",
      expect.any(Object),
      expect.objectContaining({ path: "src/hello.ts" }),
    );
  });

  it("renders markdown files through Streamdown", async () => {
    okResult({
      path: "README.md",
      kind: "text",
      size: 9,
      truncated: false,
      content: "# Title\n",
      encoding: "utf-8",
    });
    render(<PreviewPanel path="README.md" visible />);

    expect(await screen.findByTestId("streamdown")).toHaveTextContent("# Title");
    const container = screen.getByTestId("streamdown").parentElement;
    expect(container?.className).toContain("chat-markdown");
  });

  it("shows a truncated notice when the content was cut", async () => {
    okResult({
      path: "big.txt",
      kind: "text",
      size: 4096,
      truncated: true,
      content: "short",
      encoding: "utf-8",
    });
    render(<PreviewPanel path="big.txt" visible />);

    expect(await screen.findByText(/Preview truncated to the first/)).toBeInTheDocument();
  });

  it("renders images as inline data URLs", async () => {
    okResult({
      path: "pixel.png",
      kind: "image",
      size: 4,
      truncated: false,
      mimeType: "image/png",
      content: "aGk=",
    });
    render(<PreviewPanel path="pixel.png" visible />);

    const image = await screen.findByAltText("pixel.png");
    expect(image).toHaveAttribute("src", "data:image/png;base64,aGk=");
  });

  it("offers the system app for binary files", async () => {
    okResult({ path: "blob.bin", kind: "binary", size: 512, truncated: false });
    render(<PreviewPanel path="blob.bin" visible />);

    expect(await screen.findByText(/Binary file/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Open in system app" }).length).toBeGreaterThan(
      0,
    );
  });

  it("shows localized errors with a retry action", async () => {
    request.mockResolvedValue({
      ok: false,
      error: { code: "READ_FAILED", message: "Workspace path is not a file" },
    } as never);
    render(<PreviewPanel path="missing.txt" visible />);

    expect(await screen.findByText(/Workspace path is not a file/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("re-renders when a different file is selected", async () => {
    okResult({
      path: "a.ts",
      kind: "text",
      size: 2,
      truncated: false,
      content: "aa",
      encoding: "utf-8",
    });
    const { rerender } = render(<PreviewPanel path="a.ts" visible />);
    await screen.findByText("aa");

    okResult({
      path: "b.ts",
      kind: "text",
      size: 2,
      truncated: false,
      content: "bb",
      encoding: "utf-8",
    });
    rerender(<PreviewPanel path="b.ts" visible />);
    expect(await screen.findByText("bb")).toBeInTheDocument();
  });
});
