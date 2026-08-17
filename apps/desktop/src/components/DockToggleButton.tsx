import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { resolveWindowControlsPlatform } from "./WindowControls";
import { useAppStore } from "../lib/stores/app-store";
import { useT } from "../lib/i18n/use-t";
import { requestDockCommand } from "../lib/commands/events";
import { formatCommandChord } from "../lib/commands/keymap";
import { appCommands } from "../lib/commands/registry";
import { resolveCommandChord } from "../lib/commands/shortcut-bindings";

const DOCK_TOGGLE_COMMAND = appCommands.find((command) => command.id === "dock.toggle")!;

export function DockToggleButton() {
  const t = useT();
  const dockOpen = useAppStore((s) => s.dockOpen);
  const shortcutOverrides = useAppStore((s) => s.desktopSettings?.shortcutOverrides);
  const dockToggleChord = resolveCommandChord(DOCK_TOGGLE_COMMAND, shortcutOverrides);
  const dockToggleShortcut = dockToggleChord
    ? formatCommandChord(dockToggleChord, resolveWindowControlsPlatform() === "macos")
    : null;
  const dockToggleLabel = dockOpen ? t("dockCollapsePanel") : t("dockOpenPanel");

  return (
    <button
      type="button"
      title={dockToggleShortcut ? `${dockToggleLabel} (${dockToggleShortcut})` : dockToggleLabel}
      aria-label={dockOpen ? t("dockCollapseRightPanel") : t("dockOpenRightPanel")}
      aria-expanded={dockOpen}
      aria-controls="right-dock"
      data-dock-toolbar-toggle
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground"
      onClick={() => requestDockCommand({ kind: "toggle" })}
    >
      {dockOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
    </button>
  );
}
