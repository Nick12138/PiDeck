import type { Terminal } from "@xterm/xterm";

type ClipboardSurface = Pick<Terminal, "hasSelection" | "getSelection" | "paste">;

/**
 * Keyboard clipboard shortcuts for xterm surfaces.
 *
 * Without this, Ctrl+C/V are serialized to control characters (^C = SIGINT,
 * ^V = quoted-insert) and no Ctrl+Shift+C/V exists at all — so on Windows (the
 * shipping target) users cannot copy from or paste into terminals with the
 * keyboard. macOS is left untouched: Cmd+C/V reach the browser natively and
 * Ctrl keeps its control-character semantics there.
 *
 * Mirrors the VSCode / Windows Terminal contract:
 * - Ctrl+C copies when a selection exists, passes ^C (SIGINT) otherwise.
 * - Ctrl+Shift+C always copies; with no selection it is a no-op rather than
 *   sending a surprise SIGINT for what was meant as a copy.
 * - Ctrl+V and Ctrl+Shift+V paste (Ctrl+V wins over quoted-insert, as in
 *   VSCode/Windows Terminal).
 */
export function terminalClipboardKeyHandler(args: {
  terminal: ClipboardSurface;
  isMac: boolean;
  clipboard?: Pick<Clipboard, "readText" | "writeText">;
}): (event: KeyboardEvent) => boolean {
  const { terminal, isMac } = args;
  const clipboard = args.clipboard ?? navigator.clipboard;
  return (event) => {
    if (event.type !== "keydown" || isMac) return true;
    const { code, ctrlKey, shiftKey } = event;
    if (!ctrlKey) return true;

    if (shiftKey && code === "KeyC") {
      event.preventDefault();
      if (terminal.hasSelection()) {
        void clipboard.writeText(terminal.getSelection()).catch(() => undefined);
      }
      return false;
    }
    if (code === "KeyV") {
      event.preventDefault();
      void clipboard
        .readText()
        .then((text) => {
          if (text) terminal.paste(text);
        })
        .catch(() => undefined);
      return false;
    }
    if (!shiftKey && code === "KeyC" && terminal.hasSelection()) {
      event.preventDefault();
      void clipboard.writeText(terminal.getSelection()).catch(() => undefined);
      return false;
    }
    return true;
  };
}
