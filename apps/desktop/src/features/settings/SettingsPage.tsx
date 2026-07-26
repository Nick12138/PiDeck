import { useEffect, useState } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { applyTheme } from "../../lib/theme";
import {
  ArrowLeft,
  ChartColumn,
  KeyRound,
  Package,
  RefreshCw,
  ServerCog,
  Settings2,
} from "lucide-react";
import type { TerminalProfileId } from "@pideck/protocol";
import { Dialog } from "../../components/Dialog";
import { SectionHeader } from "../../components/SectionHeader";
import { Switch } from "../../components/Switch";
import { HostSettings } from "./HostSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { PackagesPage } from "../packages/PackagesPage";
import { UsageSettings } from "./UsageSettings";

type ShellProfileSummary = {
  id: TerminalProfileId;
  label: string;
  path: string;
};

type ShellProfileCatalog = {
  profiles: ShellProfileSummary[];
  automaticProfile: ShellProfileSummary;
};

function GeneralSettings() {
  const desktopSettings = useAppStore((s) => s.desktopSettings);
  const setDesktopSettings = useAppStore((s) => s.setDesktopSettings);
  const [shellCatalog, setShellCatalog] = useState<ShellProfileCatalog | null>(null);
  const [shellCatalogLoading, setShellCatalogLoading] = useState(false);
  const [shellCatalogError, setShellCatalogError] = useState<string | null>(null);

  async function loadShellProfiles() {
    setShellCatalogLoading(true);
    setShellCatalogError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setShellCatalog(await invoke<ShellProfileCatalog>("shell_terminal_profiles"));
    } catch (error) {
      setShellCatalogError(error instanceof Error ? error.message : String(error));
    } finally {
      setShellCatalogLoading(false);
    }
  }

  useEffect(() => {
    void loadShellProfiles();
  }, []);

  async function patchDesktop(patch: Record<string, unknown>) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const next = await invoke<typeof desktopSettings>("desktop_settings_patch", { patch });
      setDesktopSettings(next);
      if (patch.theme && next) applyTheme(next.theme);
    } catch {
      // Browser mock
      if (desktopSettings) {
        const next = { ...desktopSettings, ...patch } as typeof desktopSettings;
        setDesktopSettings(next);
        if (patch.theme) applyTheme(next!.theme);
      }
    }
  }


  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SectionHeader
        title="General"
        subtitle="Desktop behavior and Pi Host configuration"
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <section>
          <h2 className="mb-2 text-sm font-medium text-muted">Appearance &amp; startup</h2>
          <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
            <label className="flex items-center justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-sm">Theme</span>
                <span className="block text-xs text-muted">
                  Follow the system appearance or force light / dark.
                </span>
              </span>
              <select
                className="h-8 rounded-md border border-border bg-surface px-2 text-xs"
                value={desktopSettings?.theme ?? "system"}
                onChange={(e) =>
                  void patchDesktop({
                    theme: e.target.value as "light" | "dark" | "system",
                  })
                }
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <div className="flex items-center justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-sm">Restore last session</span>
                <span className="block text-xs text-muted">
                  Reopen your last workspace and conversation when PiDeck starts.
                </span>
              </span>
              <Switch
                checked={desktopSettings?.restoreLastSession ?? true}
                label="Restore last session"
                onChange={(next) => void patchDesktop({ restoreLastSession: next })}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="min-w-0">
                <span className="block text-sm">Auto-restart Pi Host</span>
                <span className="block text-xs text-muted">
                  If the host process crashes, restart it once automatically
                  before showing an error.
                </span>
              </span>
              <Switch
                checked={desktopSettings?.autoRestartHostOnce ?? true}
                label="Auto-restart Pi Host"
                onChange={(next) => void patchDesktop({ autoRestartHostOnce: next })}
              />
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-medium text-muted">Terminal</h2>
          <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="default-shell" className="min-w-0 text-sm">
                <span className="block">Default shell</span>
                <span className="block text-xs text-muted">
                  Shell used by terminals in the right dock.
                </span>
              </label>
              <div className="flex min-w-0 items-center gap-1.5">
                <select
                  id="default-shell"
                  className="h-8 min-w-44 max-w-72 rounded-md border border-border bg-surface px-2 text-xs"
                  value={desktopSettings?.terminalProfile ?? "auto"}
                  disabled={shellCatalogLoading && !shellCatalog}
                  onChange={(event) =>
                    void patchDesktop({
                      terminalProfile: event.target.value as TerminalProfileId,
                    })
                  }
                >
                  <option value="auto">
                    Automatic
                    {shellCatalog ? ` (${shellCatalog.automaticProfile.label})` : ""}
                  </option>
                  {shellCatalog?.profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
                    </option>
                  ))}
                  {desktopSettings?.terminalProfile &&
                    desktopSettings.terminalProfile !== "auto" &&
                    !shellCatalog?.profiles.some(
                      (profile) => profile.id === desktopSettings.terminalProfile,
                    ) && (
                      <option value={desktopSettings.terminalProfile} disabled>
                        {desktopSettings.terminalProfile} (unavailable)
                      </option>
                    )}
                </select>
                <button
                  type="button"
                  title="Detect shells again"
                  aria-label="Detect shells again"
                  disabled={shellCatalogLoading}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-50"
                  onClick={() => void loadShellProfiles()}
                >
                  <RefreshCw size={14} className={shellCatalogLoading ? "animate-spin" : ""} />
                </button>
              </div>
            </div>
            {shellCatalogError && (
              <p role="status" className="text-xs text-warning">
                {shellCatalogError}
              </p>
            )}
            {shellCatalog && (
              <p className="truncate text-right font-mono text-[11px] text-muted">
                {desktopSettings?.terminalProfile === "auto" ||
                !desktopSettings?.terminalProfile
                  ? shellCatalog.automaticProfile.path
                  : shellCatalog.profiles.find(
                      (profile) => profile.id === desktopSettings.terminalProfile,
                    )?.path}
              </p>
            )}
          </div>
        </section>

      </div>
      </div>
    </div>
  );
}

export type SettingsSection = "general" | "providers" | "packages" | "usage" | "host";

const SETTINGS_NAV: Array<{
  id: SettingsSection;
  label: string;
  icon: typeof Settings2;
}> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "providers", label: "Providers", icon: KeyRound },
  { id: "packages", label: "Packages", icon: Package },
  { id: "usage", label: "Usage", icon: ChartColumn },
  { id: "host", label: "Host", icon: ServerCog },
];

export function SettingsPage({
  initialSection = "general",
  onClose,
}: {
  initialSection?: SettingsSection;
  onClose?: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const providersDirty = useAppStore((s) => s.providersDirty);
  const [pendingSection, setPendingSection] = useState<SettingsSection | null>(null);

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  function requestSection(next: SettingsSection) {
    if (next === section) return;
    if (providersDirty) {
      setPendingSection(next);
      return;
    }
    setSection(next);
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      <header
        className="flex h-14 shrink-0 items-center border-b border-border px-4"
        data-tauri-drag-region
      >
        <button
          type="button"
          onClick={onClose}
          className="mr-3 flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
          title="Back to conversation"
          aria-label="Back to conversation"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="pointer-events-none">
          <h1 className="text-sm font-semibold">Settings</h1>
          <p className="text-[11px] text-muted">Configure PiDeck and its runtime</p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="w-52 shrink-0 border-r border-border bg-sidebar px-3 py-4">
          <p className="mb-2 px-2 text-[11px] font-medium text-muted">PiDeck</p>
          {SETTINGS_NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`mb-0.5 flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors ${
                section === id
                  ? "bg-surface-overlay font-medium text-foreground"
                  : "text-muted hover:bg-surface-overlay/70 hover:text-foreground"
              }`}
              onClick={() => requestSection(id)}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1">
          {section === "general" ? (
            <GeneralSettings />
          ) : section === "providers" ? (
            <ProvidersSettings />
          ) : section === "packages" ? (
            <PackagesPage />
          ) : section === "host" ? (
            <HostSettings />
          ) : (
            <UsageSettings />
          )}
        </div>
      </div>
      {pendingSection && (
        <Dialog
          title="Discard unsaved Provider changes?"
          confirmLabel="Discard changes"
          tone="warning"
          onCancel={() => setPendingSection(null)}
          onConfirm={() => {
            setSection(pendingSection);
            setPendingSection(null);
          }}
        >
          <p>
            The Provider form has edits that were not saved. Leaving this
            section will discard them.
          </p>
        </Dialog>
      )}
    </div>
  );
}
