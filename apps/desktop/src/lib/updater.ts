/**
 * App self-update over the Tauri updater plugin.
 *
 * All plugin imports stay dynamic so the browser mock never loads Tauri
 * internals. A check returns null when no update is available (or when
 * running outside Tauri); installing downloads the package and relaunches.
 */

export type AppUpdate = {
  version: string;
  /** Downloads, installs and relaunches the app. Resolves only on failure paths. */
  install: () => Promise<void>;
};

let inFlightCheck: Promise<AppUpdate | null> | null = null;

async function runCheck(): Promise<AppUpdate | null> {
  const { isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) return null;

  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;

  return {
    version: update.version,
    install: async () => {
      await update.downloadAndInstall();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

/** Checks the release feed; concurrent callers share one in-flight request. */
export function checkForAppUpdate(): Promise<AppUpdate | null> {
  if (!inFlightCheck) {
    inFlightCheck = runCheck().finally(() => {
      inFlightCheck = null;
    });
  }
  return inFlightCheck;
}
