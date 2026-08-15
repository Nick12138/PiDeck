/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import type { AppCommand } from "./registry";
import { findMatchingCommand, formatCommandChord, matchesCommandChord } from "./keymap";
import { appCommands } from "./registry";
import type { AppState } from "../stores/app-store";

function command(overrides: Partial<AppCommand> = {}): AppCommand {
  return {
    id: "test",
    titleKey: "commandNewSession",
    chord: "mod+n",
    run: () => undefined,
    ...overrides,
  };
}

function event(
  key: string,
  init: KeyboardEventInit,
  target: HTMLElement = document.body,
): KeyboardEvent {
  const value = new KeyboardEvent("keydown", { key, ...init });
  Object.defineProperty(value, "target", { value: target });
  return value;
}

describe("command keymap", () => {
  it("resolves mod by platform and rejects extra primary modifiers", () => {
    expect(matchesCommandChord(event("n", { metaKey: true }), "mod+n", true)).toBe(true);
    expect(matchesCommandChord(event("n", { ctrlKey: true }), "mod+n", false)).toBe(true);
    expect(matchesCommandChord(event("n", { ctrlKey: true, metaKey: true }), "mod+n", false)).toBe(
      false,
    );
  });

  it("passes composing input and terminal-owned chords through", () => {
    const composing = event("n", { ctrlKey: true, isComposing: true });
    expect(findMatchingCommand(composing, [command()], { isMac: false })).toBeNull();

    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const textarea = document.createElement("textarea");
    terminal.append(textarea);
    document.body.append(terminal);
    expect(
      findMatchingCommand(event("n", { ctrlKey: true }, textarea), [command()], {
        isMac: false,
      }),
    ).toBeNull();
    expect(
      findMatchingCommand(
        event("n", { ctrlKey: true }, textarea),
        [command({ worksInTerminal: true })],
        { isMac: false },
      )?.id,
    ).toBe("test");
  });

  it("lets shortcut recorders own captured keys and allows Alt chords in text fields", () => {
    const recorder = document.createElement("button");
    recorder.dataset.shortcutRecorder = "true";
    expect(
      findMatchingCommand(event("n", { ctrlKey: true }, recorder), [command()], {
        isMac: false,
      }),
    ).toBeNull();

    const input = document.createElement("input");
    expect(
      findMatchingCommand(event("n", { altKey: true }, input), [command({ chord: "alt+n" })], {
        isMac: false,
      })?.id,
    ).toBe("test");
  });

  it("limits unmodified Escape to the Composer and blocks it under an overlay", () => {
    const stop = command({
      chord: "escape",
      textInputSelector: ".chat-composer-input",
      blockedByOverlay: true,
    });
    const rename = document.createElement("input");
    const composer = document.createElement("textarea");
    composer.className = "chat-composer-input";
    expect(findMatchingCommand(event("Escape", {}, rename), [stop], { isMac: false })).toBeNull();
    expect(findMatchingCommand(event("Escape", {}, composer), [stop], { isMac: false })?.id).toBe(
      "test",
    );
    expect(
      findMatchingCommand(event("Escape", {}, composer), [stop], {
        isMac: false,
        hasOverlay: true,
      }),
    ).toBeNull();
  });

  it("formats platform chord hints", () => {
    expect(formatCommandChord("mod+shift+f", true)).toBe("⌘⇧F");
    expect(formatCommandChord("mod+shift+f", false)).toBe("Ctrl+Shift+F");
    expect(formatCommandChord("escape", false)).toBe("Esc");
    expect(formatCommandChord("mod+plus", true)).toBe("⌘+");
    expect(formatCommandChord("alt+arrowup", false)).toBe("Alt+↑");
  });

  it("does not bypass dirty Provider navigation from inside Settings", () => {
    const openSettings = appCommands.find((candidate) => candidate.id === "app.openSettings")!;
    expect(openSettings.enabled?.({ page: "settings", providersDirty: true } as AppState)).toBe(
      false,
    );
    expect(openSettings.enabled?.({ page: "chat", providersDirty: true } as AppState)).toBe(true);
  });
});
