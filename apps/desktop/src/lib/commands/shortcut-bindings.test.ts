import { describe, expect, it } from "vitest";
import type { AppCommand } from "./registry";
import {
  captureShortcutChord,
  findShortcutConflict,
  normalizeShortcutChord,
  resolveCommandBindings,
  resolveCommandChord,
  resetShortcutOverride,
  updateShortcutOverride,
} from "./shortcut-bindings";

const commands: AppCommand[] = [
  { id: "one", titleKey: "commandNewSession", chord: "mod+n", run() {} },
  { id: "two", titleKey: "commandOpenSettings", chord: "mod+,", run() {} },
];

function capture(
  key: string,
  init: Partial<KeyboardEvent> = {},
): Parameters<typeof captureShortcutChord>[0] {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    repeat: false,
    ...init,
  };
}

describe("shortcut bindings", () => {
  it("normalizes modifier order and rejects malformed chords", () => {
    expect(normalizeShortcutChord(" ALT + MOD + Shift + N ")).toBe("mod+shift+alt+n");
    expect(normalizeShortcutChord("mod+mod+n")).toBeNull();
    expect(normalizeShortcutChord("mod+unknown+n")).toBeNull();
  });

  it("resolves string, disabled, invalid, and default bindings", () => {
    expect(resolveCommandChord(commands[0], undefined)).toBe("mod+n");
    expect(resolveCommandChord(commands[0], { one: "mod+shift+n" })).toBe("mod+shift+n");
    expect(resolveCommandChord(commands[0], { one: null })).toBeUndefined();
    expect(resolveCommandChord(commands[0], { one: "not-a-chord" })).toBe("mod+n");
    expect(resolveCommandBindings(commands, { one: null })[0].chord).toBeUndefined();
  });

  it("stores only meaningful overrides and detects resolved conflicts", () => {
    expect(updateShortcutOverride({ one: "mod+x" }, commands[0], "mod+n")).toEqual({});
    expect(updateShortcutOverride(undefined, commands[0], null)).toEqual({ one: null });
    expect(resetShortcutOverride({ one: null, two: "mod+p" }, "one")).toEqual({
      two: "mod+p",
    });
    expect(findShortcutConflict("one", "mod+,", commands, undefined)?.id).toBe("two");
    expect(findShortcutConflict("one", "mod+,", commands, { two: null })).toBeNull();
  });

  it("captures logical platform chords and recorder control keys", () => {
    expect(captureShortcutChord(capture("N", { metaKey: true }), true)).toEqual({
      kind: "chord",
      chord: "mod+n",
    });
    expect(captureShortcutChord(capture("N", { ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: "chord",
      chord: "mod+shift+n",
    });
    expect(captureShortcutChord(capture("F2"), false)).toEqual({
      kind: "chord",
      chord: "f2",
    });
    expect(captureShortcutChord(capture("n"), false)).toEqual({
      kind: "invalid",
      reason: "modifier-required",
    });
    expect(captureShortcutChord(capture("Escape"), false)).toEqual({ kind: "cancel" });
    expect(captureShortcutChord(capture("Delete"), false)).toEqual({ kind: "clear" });
    expect(captureShortcutChord(capture("Tab"), false)).toEqual({
      kind: "passthrough",
    });
  });
});
