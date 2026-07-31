import { describe, expect, it, vi } from "vitest";
import { terminalClipboardKeyHandler } from "./terminal-clipboard";

function keyEvent(init: {
  code: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  type?: string;
}): KeyboardEvent {
  return {
    type: init.type ?? "keydown",
    code: init.code,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as KeyboardEvent;
}

function surfaceFixture(selection = "") {
  const clipboard = {
    readText: vi.fn(async () => "pasted text"),
    writeText: vi.fn(async () => undefined),
  };
  const terminal = {
    hasSelection: vi.fn(() => selection.length > 0),
    getSelection: vi.fn(() => selection),
    paste: vi.fn(),
  };
  const handler = terminalClipboardKeyHandler({
    terminal,
    isMac: false,
    clipboard,
  });
  return { clipboard, terminal, handler };
}

describe("terminalClipboardKeyHandler", () => {
  it("copies the selection on Ctrl+C instead of forwarding ^C", () => {
    const { clipboard, terminal, handler } = surfaceFixture("selected output");

    expect(handler(keyEvent({ code: "KeyC", ctrlKey: true }))).toBe(false);

    expect(clipboard.writeText).toHaveBeenCalledWith("selected output");
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it("forwards Ctrl+C as SIGINT when there is no selection", () => {
    const { clipboard, handler } = surfaceFixture();

    expect(handler(keyEvent({ code: "KeyC", ctrlKey: true }))).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("copies on Ctrl+Shift+C and swallows the no-selection case (no surprise SIGINT)", () => {
    const withSelection = surfaceFixture("selected output");
    expect(
      withSelection.handler(keyEvent({ code: "KeyC", ctrlKey: true, shiftKey: true })),
    ).toBe(false);
    expect(withSelection.clipboard.writeText).toHaveBeenCalledWith("selected output");

    const withoutSelection = surfaceFixture();
    expect(
      withoutSelection.handler(
        keyEvent({ code: "KeyC", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    expect(withoutSelection.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("pastes clipboard text on Ctrl+V and Ctrl+Shift+V", async () => {
    const { terminal, handler } = surfaceFixture();

    expect(handler(keyEvent({ code: "KeyV", ctrlKey: true }))).toBe(false);
    await vi.waitFor(() => expect(terminal.paste).toHaveBeenCalledWith("pasted text"));

    terminal.paste.mockClear();
    expect(handler(keyEvent({ code: "KeyV", ctrlKey: true, shiftKey: true }))).toBe(false);
    await vi.waitFor(() => expect(terminal.paste).toHaveBeenCalledWith("pasted text"));
  });

  it("does not paste empty clipboard content", async () => {
    const { clipboard, terminal, handler } = surfaceFixture();
    clipboard.readText.mockResolvedValue("");

    expect(handler(keyEvent({ code: "KeyV", ctrlKey: true }))).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it("passes every key through untouched on macOS (Cmd is native there)", () => {
    const { clipboard, terminal } = surfaceFixture("selected output");
    const handler = terminalClipboardKeyHandler({
      terminal,
      isMac: true,
      clipboard,
    });

    expect(handler(keyEvent({ code: "KeyC", ctrlKey: true }))).toBe(true);
    expect(handler(keyEvent({ code: "KeyV", ctrlKey: true }))).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it("ignores keyup events and non-clipboard control keys", () => {
    const { clipboard, terminal, handler } = surfaceFixture("selected output");

    expect(handler(keyEvent({ code: "KeyC", ctrlKey: true, type: "keyup" }))).toBe(true);
    expect(handler(keyEvent({ code: "KeyX", ctrlKey: true }))).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
  });
});
