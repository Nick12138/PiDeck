import { useEffect } from "react";
import { ClipboardCopy } from "lucide-react";
import { contextMenuTrigger, openContextMenu } from "./context-menu";
import { resolveTextMenuTarget, buildTextContextMenuItems } from "./text-context-menu";
import { useT } from "./i18n/use-t";

export function shouldKeepNativeContextMenu(
  event: Pick<MouseEvent, "shiftKey" | "target">,
  dev = import.meta.env.DEV,
): boolean {
  return Boolean(
    (dev && event.shiftKey) ||
      (event.target instanceof Element && event.target.closest("[data-tauri-drag-region]")),
  );
}

export function ContextMenuPolicy() {
  const t = useT();
  useEffect(() => {
    const suppressDefault = (event: MouseEvent) => {
      if (!shouldKeepNativeContextMenu(event)) event.preventDefault();
    };
    const openFallback = (event: MouseEvent) => {
      if (shouldKeepNativeContextMenu(event)) return;
      const textTarget = resolveTextMenuTarget(event.target);
      if (textTarget) {
        openContextMenu({
          x: event.clientX,
          y: event.clientY,
          trigger: contextMenuTrigger(event.target),
          items: buildTextContextMenuItems(textTarget, t),
        });
        return;
      }
      const selection = window.getSelection()?.toString() ?? "";
      if (!selection) return;
      openContextMenu({
        x: event.clientX,
        y: event.clientY,
        trigger: contextMenuTrigger(event.target),
        items: [
          {
            id: "selection.copy",
            label: t("menuCopySelection"),
            icon: ClipboardCopy,
            onSelect: () => navigator.clipboard.writeText(selection),
          },
        ],
      });
    };
    window.addEventListener("contextmenu", suppressDefault, true);
    window.addEventListener("contextmenu", openFallback);
    return () => {
      window.removeEventListener("contextmenu", suppressDefault, true);
      window.removeEventListener("contextmenu", openFallback);
    };
  }, [t]);
  return null;
}
