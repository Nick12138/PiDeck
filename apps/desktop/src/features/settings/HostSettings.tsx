import { useEffect, useState } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { SectionHeader } from "../../components/SectionHeader";
import { getAppVersion } from "../../lib/app-version";
import { persistDesktopSettings } from "../../lib/desktop-settings";
import { useT } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";

const CAPABILITY_LABELS: Record<string, MessageKey> = {
  packageUpdateCheck: "hostCapPackageUpdateCheck",
  extensionUi: "hostCapExtensionUi",
  sessionExport: "hostCapSessionExport",
};

export function HostSettings() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getAppVersion().then((version) => {
      if (!cancelled) setAppVersion(version);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function openAgentDir() {
    if (!host?.agentDir) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("desktop_open_path", { path: host.agentDir });
    } catch (err) {
      pushNotification(
        err instanceof Error ? err.message : t("notifAgentDirOpenFailed"),
        "error",
      );
    }
  }

  async function changeAgentDir() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, defaultPath: host?.agentDir });
      if (typeof picked !== "string" || picked === host?.agentDir) return;
      await persistDesktopSettings({ agentDir: picked });
      pushNotification(t("notifAgentDirChanged"), "warning");
    } catch (err) {
      pushNotification(
        err instanceof Error ? err.message : t("notifAgentDirChangeFailed"),
        "error",
      );
    }
  }

  async function restartHost() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      useAppStore.getState().setHostFatal(null);
      useAppStore.getState().setConnecting(true);
      hostClient.rejectAllPending("manual Host restart");
      await invoke("pi_host_restart");
      pushNotification(t("notifHostRestarted"));
    } catch (err) {
      useAppStore.getState().setConnecting(false);
      useAppStore.getState().setHostFatal(err instanceof Error ? err.message : String(err));
      pushNotification(t("notifHostRestartFailed"), "error");
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SectionHeader title={t("navHost")} subtitle={t("hostSubtitle")} />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-8">
          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">{t("hostRuntimeGroup")}</h2>
            <div className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted">SDK</span>
                <span className="font-mono">{host?.sdkVersion ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Node</span>
                <span className="font-mono">{host?.nodeVersion ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">{t("hostPhase")}</span>
                <span>{host?.phase ?? "—"}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="shrink-0 text-muted">{t("hostAgentDir")}</span>
                <span className="truncate font-mono text-xs" title={host?.agentDir}>
                  {host?.agentDir ?? "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">{t("hostModelConfig")}</span>
                <span
                  className={
                    host?.modelConfigHealth?.state === "ok" ? "text-success" : "text-warning"
                  }
                  title={host?.modelConfigHealth?.message}
                >
                  {host?.modelConfigHealth?.state ?? "—"}
                </span>
              </div>
              {host?.modelConfigHealth?.state === "degraded" && (
                <p className="text-xs text-warning">{t("hostModelConfigDegraded")}</p>
              )}
              {host?.modelConfigHealth?.migrationHint && (
                <p className="text-xs text-warning">
                  {host.modelConfigHealth.migrationHint.message}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" className={secondaryButton} onClick={() => void openAgentDir()}>
                  {t("hostOpenAgentDir")}
                </button>
                <button type="button" className={secondaryButton} onClick={() => void changeAgentDir()}>
                  {t("hostChangeAgentDir")}
                </button>
              </div>
              <div className="mt-3 border-t border-border pt-3">
                <button
                  type="button"
                  className={`${secondaryButton} border-danger/40 text-danger hover:bg-danger/10`}
                  onClick={() => setConfirmRestart(true)}
                >
                  {t("hostRestart")}
                </button>
                <p className="mt-1.5 text-xs text-muted">{t("hostRestartCaption")}</p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">{t("hostCapabilitiesGroup")}</h2>
            <div className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
              {host ? (
                Object.entries(host.capabilities).map(([key, enabled]) => (
                  <div key={key} className="flex justify-between">
                    <span className="text-muted">
                      {CAPABILITY_LABELS[key] ? t(CAPABILITY_LABELS[key]) : key}
                    </span>
                    <span className={enabled ? "text-success" : "text-muted"}>
                      {enabled ? t("commonEnabled") : t("commonUnavailable")}
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-xs text-muted">{t("hostNotConnected")}</p>
              )}
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">{t("hostAboutGroup")}</h2>
            <div className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted">PiDeck</span>
                <span className="font-mono">{appVersion ?? "—"}</span>
              </div>
            </div>
          </section>
        </div>
      </div>
      {confirmRestart && (
        <Dialog
          title={t("hostRestartDialogTitle")}
          confirmLabel={t("hostRestart")}
          tone="warning"
          onCancel={() => setConfirmRestart(false)}
          onConfirm={() => {
            setConfirmRestart(false);
            void restartHost();
          }}
        >
          <p>{t("hostRestartDialogBody")}</p>
        </Dialog>
      )}
    </div>
  );
}
