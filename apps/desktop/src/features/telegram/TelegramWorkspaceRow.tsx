import { FolderOpen, LoaderCircle, Pencil, Send, Settings } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { contextMenuTrigger, openContextMenu } from "../../lib/context-menu";
import { shouldKeepNativeContextMenu } from "../../lib/context-menu-policy";
import { isSameTelegramPath } from "../../lib/telegram-path";
import {
  loadTelegramBridgePrefEnabled,
  loadTelegramWorkspaceDisplayName,
  maybeAutoStartTelegramBridge,
  saveTelegramWorkspaceDisplayName,
  useTelegramViewStore,
  useTelegramWorkspaceActive,
} from "./telegram-view-store";
import { TelegramRenameDialog } from "./TelegramRenameDialog";
import { TelegramSettingsDialog } from "./TelegramSettingsDialog";

/**
 * The telegram workspace rendered as a row inside the regular workspace list.
 *
 * Unlike the old virtual view (frontend-only state), selecting this row now
 * switches to the REAL dedicated workspace (`<agentDir>/workspace/telegram`)
 * through the normal host-switch machinery, so the bridge's polling session
 * lives in this workspace and TG turns never land in other workspaces. On
 * entry, the bridge auto-starts when a profile is configured and no owner is
 * live. The row is always visible; the subtitle reflects the bind state.
 */
export function TelegramWorkspaceRow({
  onActivate,
}: {
  /** Real workspace switch for the telegram workspace path. */
  onActivate: (path: string) => Promise<void>;
}) {
  const t = useT();
  const active = useTelegramWorkspaceActive();
  const profile = useTelegramViewStore((s) => s.profile);
  const workspacePath = useTelegramViewStore((s) => s.workspacePath);
  const loaded = useTelegramViewStore((s) => s.loaded);
  const loading = useTelegramViewStore((s) => s.loading);
  const bridgeStatus = useTelegramViewStore((s) => s.bridgeStatus);
  const bridgeLoading = useTelegramViewStore((s) => s.bridgeLoading);
  const refresh = useTelegramViewStore((s) => s.refreshTelegramSessions);
  const refreshStatus = useTelegramViewStore((s) => s.refreshBridgeStatus);
  const ensureWorkspace = useTelegramViewStore((s) => s.ensureTelegramWorkspace);
  // Host presence drives the initial refresh: on app startup the host is
  // async and may not be ready when this row first mounts, which would
  // otherwise skip the load and hide the entry permanently.
  const hostReady = useAppStore((s) => s.host?.hostInstanceId);
  const connecting = useAppStore((s) => s.connecting);
  const rehydrating = useAppStore((s) => s.rehydrating);
  const desynchronized = useAppStore((s) => s.desynchronized);
  const [displayName, setDisplayName] = useState<string | null>(() =>
    loadTelegramWorkspaceDisplayName(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);

  // Refresh on mount and again once the host becomes available, so a
  // persisted telegram.json / journaled history shows up after startup.
  useEffect(() => {
    void ensureWorkspace().then(() => {
      void refresh();
      void refreshStatus();
    });
  }, [ensureWorkspace, hostReady, refresh, refreshStatus]);

  // Boot straight into the telegram workspace once the app has settled and the
  // bridge is meant to run: a configured profile plus the bridge switch being
  // on means the user's TG channel should be front and center. Fires at most
  // once per app session (the sidebar row stays mounted across switches).
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const autoEnteredRef = useRef(false);
  useEffect(() => {
    if (autoEnteredRef.current) return;
    if (!hostReady || connecting || rehydrating || desynchronized) return;
    const store = useTelegramViewStore.getState();
    if (!store.loaded || !store.profile?.configured) return;
    if (!loadTelegramBridgePrefEnabled()) return;
    autoEnteredRef.current = true;
    void (async () => {
      const path = await useTelegramViewStore.getState().ensureTelegramWorkspace();
      if (!path) return;
      const currentCwd = useAppStore.getState().workspace?.canonicalCwd ?? null;
      if (isSameTelegramPath(currentCwd, path)) return;
      await onActivateRef.current(path);
      void refresh();
      void maybeAutoStartTelegramBridge();
    })();
  }, [hostReady, connecting, rehydrating, desynchronized, loaded, profile, refresh]);

  const openFolder = useCallback(() => {
    void (async () => {
      if (!workspacePath) await ensureWorkspace();
      const path = useTelegramViewStore.getState().workspacePath;
      if (!path) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("desktop_open_path", { path });
      } catch {
        /* no-op: the native open failed silently */
      }
    })();
  }, [ensureWorkspace, workspacePath]);

  async function handleActivate() {
    const path = await ensureWorkspace();
    if (!path) return;
    if (!active) {
      await onActivate(path);
    }
    // Either the switch completed or we were already inside the telegram
    // workspace: refresh history and let auto-start retry when disconnected.
    void refresh();
    void maybeAutoStartTelegramBridge();
  }

  const botLabel = profile?.botUsername ? `@${profile.botUsername}` : "Telegram";
  const title = displayName ?? botLabel;
  const subtitle = !loaded
    ? undefined
    : profile === null
      ? t("tgRowUnconfigured")
      : (profile.botName ?? undefined);

  // Priority: green (connected) > amber (status loading) > gray (configured
  // but disconnected) > none (no profile yet).
  const statusDot =
    bridgeStatus?.connected
      ? "bg-success status-dot-pulse"
      : bridgeLoading
        ? "bg-warning status-dot-pulse"
        : profile !== null
          ? "bg-muted"
          : null;
  const statusTitle = bridgeStatus?.connected
    ? t("tgBridgeConnected")
    : profile !== null
      ? t("tgBridgeDisconnected")
      : undefined;

  const onContextMenu = (event: React.MouseEvent) => {
    if (shouldKeepNativeContextMenu(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      trigger: contextMenuTrigger(event.target),
      items: [
        {
          id: "telegram-settings",
          label: t("tgCtxSettings"),
          icon: Settings,
          onSelect: () => setSettingsOpen(true),
        },
        {
          id: "telegram-rename",
          label: t("tgCtxRename"),
          icon: Pencil,
          onSelect: () => setRenameOpen(true),
        },
        {
          id: "telegram-open-folder",
          label: t("tgCtxOpenFolder"),
          icon: FolderOpen,
          separatorBefore: true,
          onSelect: () => openFolder(),
        },
      ],
    });
  };

  return (
    <li
      className={`interface-density-nav-row flex h-9 items-center rounded-md text-[13px] ${
        active ? "bg-surface-overlay font-medium" : "hover:bg-surface-overlay/70"
      }`}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        onClick={() => void handleActivate()}
        aria-current={active ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
        title={t("tgWorkspaceEnterTitle", { name: title })}
      >
        {loading ? (
          <LoaderCircle size={16} className="shrink-0 animate-spin text-muted" />
        ) : (
          <Send size={16} className={`shrink-0 ${active ? "text-accent" : "text-muted"}`} />
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {subtitle && (
          <span className="shrink-0 truncate text-[10px] text-muted">{subtitle}</span>
        )}
        {statusDot && (
          <span
            className={`size-[8.2px] shrink-0 rounded-full ${statusDot}`}
            title={statusTitle}
          />
        )}
      </button>
      {settingsOpen && (
        <TelegramSettingsDialog
          onCancel={() => setSettingsOpen(false)}
          onChanged={() => {
            void refresh();
            void refreshStatus();
            setDisplayName(loadTelegramWorkspaceDisplayName());
          }}
        />
      )}
      {renameOpen && (
        <TelegramRenameDialog
          currentName={displayName ?? botLabel}
          onCancel={() => setRenameOpen(false)}
          onConfirm={(name) => {
            saveTelegramWorkspaceDisplayName(name);
            setDisplayName(loadTelegramWorkspaceDisplayName());
            setRenameOpen(false);
          }}
        />
      )}
    </li>
  );
}