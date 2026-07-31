import { isTauri } from "@tauri-apps/api/core";
import { readText } from "@tauri-apps/plugin-clipboard-manager";

export function readClipboardText(): Promise<string> {
  if (isTauri()) return readText();
  return navigator.clipboard.readText();
}
