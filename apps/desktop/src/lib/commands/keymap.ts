import type { AppCommand } from "./registry";

export type KeymapContext = {
  isMac: boolean;
  hasOverlay?: boolean;
};

function normalizedKey(event: KeyboardEvent): string {
  return event.key.toLocaleLowerCase();
}

export function matchesCommandChord(
  event: KeyboardEvent,
  chord: string,
  isMac: boolean,
): boolean {
  const parts = chord.toLocaleLowerCase().split("+");
  const key = parts.at(-1);
  const needsMod = parts.includes("mod");
  const needsShift = parts.includes("shift");
  const needsAlt = parts.includes("alt");
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const secondaryPrimary = isMac ? event.ctrlKey : event.metaKey;
  return (
    normalizedKey(event) === key &&
    primary === needsMod &&
    secondaryPrimary === false &&
    event.shiftKey === needsShift &&
    event.altKey === needsAlt
  );
}

function closest(target: EventTarget | null, selector: string): Element | null {
  return target instanceof Element ? target.closest(selector) : null;
}

export function isTextInputTarget(target: EventTarget | null): boolean {
  return Boolean(
    closest(
      target,
      'input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, [contenteditable="true"]',
    ),
  );
}

export function findMatchingCommand(
  event: KeyboardEvent,
  commands: readonly AppCommand[],
  context: KeymapContext,
): AppCommand | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  const command = commands.find(
    (candidate) =>
      candidate.chord && matchesCommandChord(event, candidate.chord, context.isMac),
  );
  if (!command) return null;
  if (closest(event.target, ".xterm") && !command.worksInTerminal) return null;
  if (isTextInputTarget(event.target) && !command.chord?.includes("mod+")) {
    if (!command.textInputSelector || !closest(event.target, command.textInputSelector)) {
      return null;
    }
  }
  if (command.blockedByOverlay && context.hasOverlay) return null;
  return command;
}

export function formatCommandChord(chord: string, isMac: boolean): string {
  const labels = chord.split("+").map((part) => {
    if (part === "mod") return isMac ? "⌘" : "Ctrl";
    if (part === "shift") return isMac ? "⇧" : "Shift";
    if (part === "alt") return isMac ? "⌥" : "Alt";
    if (part === "escape") return "Esc";
    return part.length === 1 ? part.toLocaleUpperCase() : part;
  });
  return isMac ? labels.join("") : labels.join("+");
}
