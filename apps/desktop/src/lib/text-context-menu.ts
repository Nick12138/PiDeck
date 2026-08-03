import { ClipboardCopy, ClipboardPaste, Scissors, TextSelect } from "lucide-react";
import type { Translate } from "./i18n/use-t";
import type { MenuItem } from "./context-menu";
import { resolveWindowControlsPlatform } from "../components/WindowControls";
import { formatCommandChord } from "./commands/keymap";
import { readClipboardText } from "./desktop-clipboard";

export type TextMenuTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

export function resolveTextMenuTarget(target: EventTarget | null): TextMenuTarget | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(
    'input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, [contenteditable="true"]',
  );
  if (!element) return null;
  return element as TextMenuTarget;
}

function isFormField(target: TextMenuTarget): target is HTMLInputElement | HTMLTextAreaElement {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function selectedTextForTarget(target: TextMenuTarget): string {
  if (isFormField(target)) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    return target.value.slice(start, end);
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0);
  return target.contains(range.commonAncestorContainer) ? selection.toString() : "";
}

function emitInput(target: HTMLElement, inputType: string, data: string | null): void {
  target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
}

export function insertTextAtSelection(target: TextMenuTarget, text: string): void {
  if (isFormField(target)) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.setRangeText(text, start, end, "end");
    emitInput(target, "insertFromPaste", text);
    return;
  }
  target.focus();
  document.execCommand("insertText", false, text);
}

async function copySelection(target: TextMenuTarget): Promise<void> {
  const text = selectedTextForTarget(target);
  if (text) await navigator.clipboard.writeText(text);
}

async function cutSelection(target: TextMenuTarget): Promise<void> {
  const text = selectedTextForTarget(target);
  if (!text) return;
  await navigator.clipboard.writeText(text);
  if (isFormField(target)) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    target.setRangeText("", start, end, "end");
    emitInput(target, "deleteByCut", null);
    return;
  }
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    selection.getRangeAt(0).deleteContents();
    emitInput(target, "deleteByCut", null);
  }
}

function selectAllText(target: TextMenuTarget): void {
  target.focus();
  if (isFormField(target)) {
    target.select();
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(target);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function buildTextContextMenuItems(
  target: TextMenuTarget,
  t: Translate,
  extraItems: MenuItem[] = [],
): MenuItem[] {
  const selection = selectedTextForTarget(target);
  const isMac = resolveWindowControlsPlatform() === "macos";
  const readOnly = isFormField(target) && (target.readOnly || target.disabled);
  return [
    {
      id: "edit.cut",
      label: t("menuCut"),
      icon: Scissors,
      chordHint: formatCommandChord("mod+x", isMac),
      disabled: readOnly || selection.length === 0,
      onSelect: () => cutSelection(target),
    },
    {
      id: "edit.copy",
      label: t("menuCopy"),
      icon: ClipboardCopy,
      chordHint: formatCommandChord("mod+c", isMac),
      disabled: selection.length === 0,
      onSelect: () => copySelection(target),
    },
    {
      id: "edit.paste",
      label: t("menuPaste"),
      icon: ClipboardPaste,
      chordHint: formatCommandChord("mod+v", isMac),
      disabled: readOnly,
      onSelect: async () => {
        const text = await readClipboardText();
        if (text) insertTextAtSelection(target, text);
      },
    },
    ...extraItems,
    {
      id: "edit.selectAll",
      label: t("menuSelectAll"),
      icon: TextSelect,
      chordHint: formatCommandChord("mod+a", isMac),
      separatorBefore: extraItems.length === 0,
      onSelect: () => selectAllText(target),
    },
  ];
}
