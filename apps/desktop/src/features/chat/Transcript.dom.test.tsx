/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { Transcript } from "./Transcript";
import { MenuHost } from "../../components/Menu";

const linkMocks = vi.hoisted(() => ({
  requestDockBrowser: vi.fn(),
  openSystemUrl: vi.fn(),
}));

vi.mock("../../lib/dock-browser", () => ({
  requestDockBrowser: linkMocks.requestDockBrowser,
}));

vi.mock("../../lib/open-system-url", () => ({
  openSystemUrl: linkMocks.openSystemUrl,
}));

const SESSION_A = "33333333-3333-4333-8333-333333333333";
const SESSION_B = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function session(sessionId: string, text: string): SessionSnapshot {
  return {
    sessionId,
    cwd: "/workspace",
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [{ role: "user", content: text }],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId,
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };
}

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  observe() {}
  unobserve() {}
  disconnect() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let nextFrameId = 1;
let frames = new Map<number, FrameRequestCallback>();

function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}

describe("Transcript Session-open scrolling", () => {
  beforeEach(() => {
    nextFrameId = 1;
    frames = new Map();
    TestResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => {
        frames.delete(id);
      }),
    );
    useAppStore.setState({
      session: session(SESSION_A, "First Session"),
      desktopSettings: {
        theme: "system",
        language: "en",
        restoreLastSession: true,
        autoRestartHostOnce: true,
        extensionDecisionPresentation: "auto",
        terminalProfile: "auto",
      },
    });
    linkMocks.requestDockBrowser.mockReset().mockReturnValue(true);
    linkMocks.openSystemUrl.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (navigator as { clipboard?: Clipboard }).clipboard;
    useAppStore.setState({ session: null, desktopSettings: null });
  });

  it("keeps a newly opened Session at the bottom through late content growth", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 900;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    flushFrames();
    expect(scroll.scrollTop).toBe(900);

    scrollHeight = 1_400;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();
    expect(scroll.scrollTop).toBe(1_400);
  });

  it("stops following manual history reads and resets to the bottom for the next Session", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 1_000;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    flushFrames();

    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    scrollHeight = 1_300;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();
    expect(scroll.scrollTop).toBe(100);

    scrollHeight = 1_700;
    act(() => useAppStore.setState({ session: session(SESSION_B, "Second Session") }));
    flushFrames();
    expect(scroll.scrollTop).toBe(1_700);
  });

  it("releases a small upward gesture before a queued tail alignment", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 1_000;
    const clientHeight = 300;
    let scrollTop = 0;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight));
        },
      },
    });
    flushFrames();
    expect(scroll.scrollTop).toBe(700);

    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    fireEvent.wheel(scroll, { deltaY: -20 });
    scroll.scrollTop = 680;
    fireEvent.scroll(scroll);
    flushFrames();

    expect(scroll.scrollTop).toBe(680);
    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeInTheDocument();

    scroll.scrollTop = 695;
    fireEvent.scroll(scroll);
    scrollHeight = 1_100;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();
    expect(scroll.scrollTop).toBe(800);
  });

  it("keeps following when content shrinkage lowers the maximum scroll position", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 1_000;
    const clientHeight = 300;
    let scrollTop = 0;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight));
        },
      },
    });
    flushFrames();
    expect(scroll.scrollTop).toBe(700);

    scrollHeight = 900;
    scroll.scrollTop = 600;
    fireEvent.scroll(scroll);
    scrollHeight = 950;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();

    expect(scroll.scrollTop).toBe(650);
    expect(
      screen.queryByRole("button", { name: "Jump to latest message" }),
    ).not.toBeInTheDocument();
  });

  it("opens a row context menu and copies the complete message", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    fireEvent.contextMenu(container.querySelector(".transcript-row")!, {
      clientX: 24,
      clientY: 32,
    });
    await user.click(await screen.findByRole("menuitem", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("First Session"));
  });

  it("adds Dock, external-browser, and copy actions when right-clicking a link", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    const row = container.querySelector<HTMLElement>(".transcript-row")!;
    const link = document.createElement("a");
    link.href = "https://example.com/docs";
    link.textContent = "Documentation";
    row.append(link);

    fireEvent.contextMenu(link, { clientX: 24, clientY: 32 });
    expect(await screen.findByRole("menuitem", { name: "Open in Dock" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open in external browser" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy message" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Open in Dock" }));
    expect(linkMocks.requestDockBrowser).toHaveBeenCalledWith({
      url: "https://example.com/docs",
    });

    fireEvent.contextMenu(link, { clientX: 24, clientY: 32 });
    await user.click(await screen.findByRole("menuitem", { name: "Open in external browser" }));
    expect(linkMocks.openSystemUrl).toHaveBeenCalledWith("https://example.com/docs");

    fireEvent.contextMenu(link, { clientX: 24, clientY: 32 });
    await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://example.com/docs"));

    expect(row).toBeInTheDocument();
  });

  it("leaves development Shift-right-click available for the native menu", () => {
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    fireEvent.contextMenu(container.querySelector(".transcript-row")!, {
      clientX: 24,
      clientY: 32,
      shiftKey: true,
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
