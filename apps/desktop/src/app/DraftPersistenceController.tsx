import { useEffect, useMemo, useRef } from "react";
import {
  flushDraftWrites,
  hydrateDraftWorkspace,
  settleDraftWritesWithin,
} from "../lib/draft-persistence";
import { draftKeyForTarget, draftTargetFor } from "../lib/draft-target";
import { useAppStore } from "../lib/stores/app-store";

export function shouldAwaitDraftFlushOnClose(
  tauriPlatform = import.meta.env.TAURI_ENV_PLATFORM,
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  const platform = tauriPlatform?.toLowerCase();
  if (platform) return platform !== "windows" && platform !== "win32";
  return !/Windows/i.test(userAgent);
}

export function DraftPersistenceController() {
  const workspace = useAppStore((state) => state.workspace);
  const session = useAppStore((state) => state.session);
  const clearDraftWorkspace = useAppStore((state) => state.clearDraftWorkspace);
  const previousCanonicalCwd = useRef<string | null>(null);
  const targetKey = useMemo(() => {
    const target = draftTargetFor(workspace, session);
    return target ? draftKeyForTarget(target) : null;
  }, [session, workspace]);

  useEffect(() => {
    const canonicalCwd = workspace?.canonicalCwd;
    if (!canonicalCwd) return;
    const previous = previousCanonicalCwd.current;
    if (previous && previous !== canonicalCwd) {
      void flushDraftWrites();
      clearDraftWorkspace(previous);
    }
    previousCanonicalCwd.current = canonicalCwd;
    void hydrateDraftWorkspace(canonicalCwd);
  }, [clearDraftWorkspace, workspace?.canonicalCwd]);

  useEffect(
    () => () => {
      void flushDraftWrites();
    },
    [targetKey],
  );

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") void flushDraftWrites();
    };
    const flushOnPageHide = () => void flushDraftWrites();
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", flushOnPageHide);
      void flushDraftWrites();
    };
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || !shouldAwaitDraftFlushOnClose()) return;
    let disposed = false;
    let stopListening = () => {};
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      const unlisten = await appWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await settleDraftWritesWithin();
        } finally {
          await appWindow.destroy();
        }
      });
      if (disposed) unlisten();
      else stopListening = unlisten;
    })().catch(() => undefined);
    return () => {
      disposed = true;
      stopListening();
    };
  }, []);

  return null;
}
