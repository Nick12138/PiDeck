import { useEffect, useMemo, useState } from "react";
import { Keyboard } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { MenuHost } from "../../components/Menu";
import { resolveWindowControlsPlatform } from "../../components/WindowControls";
import { closeContextMenu } from "../context-menu";
import { ContextMenuPolicy } from "../context-menu-policy";
import { useT } from "../i18n/use-t";
import { useAppStore } from "../stores/app-store";
import { findMatchingCommand } from "./keymap";
import { appCommands } from "./registry";
import { subscribeShortcutHelp } from "./events";
import { ShortcutReference } from "./ShortcutReference";
import { resolveCommandBindings } from "./shortcut-bindings";

export function CommandLayer() {
  const t = useT();
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const isMac = resolveWindowControlsPlatform() === "macos";
  const shortcutOverrides = useAppStore(
    (state) => state.desktopSettings?.shortcutOverrides,
  );
  const commands = useMemo(
    () => resolveCommandBindings(appCommands, shortcutOverrides),
    [shortcutOverrides],
  );

  useEffect(() => subscribeShortcutHelp(() => setShortcutHelpOpen(true)), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = findMatchingCommand(event, commands, {
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
  }, [commands, isMac]);

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
          <div className="-mx-4 max-h-[min(520px,60vh)] overflow-y-auto">
            <ShortcutReference isMac={isMac} />
          </div>
        </Dialog>
      )}
    </>
  );
}
