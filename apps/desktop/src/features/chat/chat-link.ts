import { requestDockBrowser } from "../../lib/dock-browser";
import { openSystemUrl } from "../../lib/open-system-url";
import { isSafeExternalUrl } from "./markdown-utils";

export type ChatLinkActivation = {
  button?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

export function usesSystemBrowser(activation: ChatLinkActivation): boolean {
  return Boolean(
    activation.button === 1 ||
    activation.altKey ||
    activation.ctrlKey ||
    activation.metaKey ||
    activation.shiftKey,
  );
}

/** Route a safe chat link to the Dock, retaining explicit system-browser access. */
export function openChatLink(url: string, activation: ChatLinkActivation = {}): boolean {
  if (!isSafeExternalUrl(url)) return false;
  if (!usesSystemBrowser(activation) && requestDockBrowser({ url })) return true;
  void openSystemUrl(url);
  return true;
}
