import { useState } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { tCurrent, useT } from "../../lib/i18n/use-t";

async function restartHost(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    useAppStore.getState().setHostFatal(null);
    useAppStore.getState().setConnecting(true);
    hostClient.rejectAllPending("manual Host restart");
    await invoke("pi_host_restart");
    useAppStore.getState().pushNotification(tCurrent("notifHostRestarted"));
  } catch (err) {
    useAppStore.getState().setConnecting(false);
    useAppStore.getState().setHostFatal(err instanceof Error ? err.message : String(err));
    useAppStore.getState().pushNotification(tCurrent("notifHostRestartFailed"), "error");
  }
}

/**
 * Restart button with the shared confirm dialog. Danger styling is NOT baked
 * in — pass it via className where the context calls for it (Host section).
 */
export function RestartHostButton({ className }: { className?: string }) {
  const t = useT();
  const [confirmRestart, setConfirmRestart] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className ?? secondaryButton}
        onClick={() => setConfirmRestart(true)}
      >
        {t("hostRestart")}
      </button>
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
    </>
  );
}
