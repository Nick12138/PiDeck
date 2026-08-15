import { resolveWindowControlsPlatform } from "../../components/WindowControls";
import { useT } from "../i18n/use-t";
import { useAppStore } from "../stores/app-store";
import { formatCommandChord } from "./keymap";
import { appCommands } from "./registry";
import { resolveCommandChord } from "./shortcut-bindings";

export function ShortcutReference({
  isMac = resolveWindowControlsPlatform() === "macos",
}: {
  isMac?: boolean;
}) {
  const t = useT();
  const shortcutOverrides = useAppStore((state) => state.desktopSettings?.shortcutOverrides);

  return (
    <dl>
      {appCommands
        .filter((command) => command.chord)
        .map((command) => {
          const chord = resolveCommandChord(command, shortcutOverrides);
          return (
            <div
              key={command.id}
              className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border/60 px-4 py-2.5 last:border-b-0"
            >
              <dt className="min-w-0 text-sm text-foreground">
                {t(command.titleKey, command.titleParams)}
              </dt>
              <dd>
                {chord ? (
                  <kbd className="inline-flex min-w-8 items-center justify-center rounded-md border border-border bg-surface-overlay px-2 py-1 font-mono text-[11px] leading-none text-muted shadow-sm">
                    {formatCommandChord(chord, isMac)}
                  </kbd>
                ) : (
                  <span className="text-xs text-muted">{t("shortcutsUnassigned")}</span>
                )}
              </dd>
            </div>
          );
        })}
    </dl>
  );
}
