import type { DesktopSettings } from "@pideck/protocol";
import { tCurrent } from "./i18n/use-t";
import { useAppStore } from "./stores/app-store";

export type DesktopSettingsSnapshot = {
  schemaVersion: number;
  settings: DesktopSettings;
  warning?: string;
  recoveredFrom?: string;
};

export type DesktopSettingsUpdate = Omit<
  Partial<DesktopSettings>,
  "defaultWorkspace" | "lastWorkspace" | "lastSessionPath" | "agentDir"
> & {
  defaultWorkspace?: string | null;
  lastWorkspace?: string | null;
  lastSessionPath?: string | null;
  agentDir?: string | null;
};

let settingsWriteQueue: Promise<void> = Promise.resolve();

export function recentDesktopLocationPatch(
  workspacePath: string,
  sessionPath: string | null,
): DesktopSettingsUpdate {
  return {
    lastWorkspace: workspacePath,
    lastSessionPath: sessionPath,
  };
}

function applyLocalPatch(
  current: DesktopSettings,
  patch: DesktopSettingsUpdate,
): DesktopSettings {
  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next as DesktopSettings;
}

export function notifyDesktopSettingsSaveFailure(error: unknown): void {
  const summary = tCurrent("notifDesktopSettingsSaveFailed");
  const detail =
    error instanceof Error
      ? error.message.trim()
      : typeof error === "string"
        ? error.trim()
        : "";
  useAppStore
    .getState()
    .pushNotification(detail ? `${summary}: ${detail}` : summary, "error");
}

async function writeDesktopSettings(patch: DesktopSettingsUpdate): Promise<void> {
  const current = useAppStore.getState().desktopSettings;
  if (!current) return;
  const nextLocal = applyLocalPatch(current, patch);
  if (JSON.stringify(nextLocal) === JSON.stringify(current)) return;

  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) {
    useAppStore.getState().setDesktopSettings(nextLocal);
    return;
  }

  const next = await invoke<DesktopSettings>("desktop_settings_patch", { patch });
  useAppStore.getState().setDesktopSettings(next);
}

export function persistDesktopSettings(patch: DesktopSettingsUpdate): Promise<void> {
  settingsWriteQueue = settingsWriteQueue
    .catch(() => undefined)
    .then(() => writeDesktopSettings(patch));
  return settingsWriteQueue;
}

export function persistRecentDesktopLocation(
  workspacePath: string,
  sessionPath: string | null,
): Promise<void> {
  return persistDesktopSettings(recentDesktopLocationPatch(workspacePath, sessionPath));
}
