import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { MenuHost } from "../../components/Menu";
import { resolveWindowControlsPlatform } from "../../components/WindowControls";
import { closeContextMenu } from "../context-menu";
import { ContextMenuPolicy } from "../context-menu-policy";
import { useT } from "../i18n/use-t";
import { useAppStore } from "../stores/app-store";
import { findMatchingCommand, formatCommandChord } from "./keymap";
import { appCommands } from "./registry";
import { subscribeShortcutHelp } from "./events";

export function CommandLayer() {
  const t = useT();
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const isMac = resolveWindowControlsPlatform() === "macos";

  useEffect(() => subscribeShortcutHelp(() => setShortcutHelpOpen(true)), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = findMatchingCommand(event, appCommands, {
        isMac,
        hasOverlay: Boolean(
          document.querySelector(
            '[role="dialog"], [role="menu"], [data-composer-completion]',
          ),
        ),
      });
      if (!command || command.enabled?.(useAppStore.getState()) === false) return;
      event.preventDefault();
      event.stopPropagation();
      closeContextMenu();
      void command.run();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isMac]);

  const closeShortcutHelp = () => setShortcutHelpOpen(false);
  return (
    <>
      <ContextMenuPolicy />
      <MenuHost />
      {shortcutHelpOpen && (
        <Dialog
          title={t("shortcutsTitle")}
          confirmLabel={t("commonClose")}
          icon={Keyboard}
          showCancel={false}
          onCancel={closeShortcutHelp}
          onConfirm={closeShortcutHelp}
        >
          <div className="-mx-1 grid max-h-[min(520px,60vh)] grid-cols-[minmax(0,1fr)_auto] gap-x-4 overflow-y-auto px-1">
            {appCommands
              .filter((command) => command.chord)
              .map((command) => (
                <div key={command.id} className="contents">
                  <span className="border-b border-border/60 py-2 text-foreground">
                    {t(command.titleKey, command.titleParams)}
                  </span>
                  <kbd className="border-b border-border/60 py-2 text-right font-mono text-[11px] text-muted">
                    {formatCommandChord(command.chord!, isMac)}
                  </kbd>
                </div>
              ))}
          </div>
        </Dialog>
      )}
    </>
  );
}
