import { ChevronDown, Folder, FolderPlus, LoaderCircle, MessageCircle, Plus, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activateWorkspaceHost,
  fetchHostActivity,
  prepareWorkspaceHost,
  rebindActiveWorkspaceHost,
  replayActiveHostReady,
  subscribeHostActivity,
} from "../../lib/bridge/tauri-transport";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import {
  notifyDesktopSettingsSaveFailure,
  persistDesktopSettings,
} from "../../lib/desktop-settings";
import { sidebarPref, setSidebarPref } from "../../lib/sidebar-prefs";
import { useT } from "../../lib/i18n/use-t";
import { workspaceContext } from "../../lib/bridge/host-context";
import {
  isWorkspaceSwitchBusyError,
  waitForWorkspaceActivation,
  workspaceHasActiveAgent,
} from "./workspace-switch-policy";
import { TelegramAddDialog } from "../bot/TelegramAddDialog";
import { addGateway, type BotGateway } from "../bot/gateway-store";

export function workspaceDisplayName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace";
}

/** Renderer path identity uses only Host-canonical strings. */
function samePath(a: string, b: string): boolean {
  return a === b;
}

/**
 * The Rust Host pool lowercases workspace keys on Windows, and the activity
 * snapshot returns each entry's Rust-canonicalized cwd — which can differ from
 * the renderer's casing. Normalize both sides the same way for lookups.
 */
function normalizedActivityKey(path: string): string {
  return /^win/i.test(navigator.platform) ? path.toLowerCase() : path;
}

export function addKnownWorkspace(list: string[], path: string): string[] {
  return list.some((entry) => samePath(entry, path)) ? list : [...list, path];
}

export function removeKnownWorkspace(list: string[], path: string): string[] {
  return list.filter((entry) => !samePath(entry, path));
}

export function replaceKnownWorkspace(
  list: string[],
  requestedPath: string,
  canonicalPath: string,
): string[] {
  const next = list.map((entry) => (samePath(entry, requestedPath) ? canonicalPath : entry));
  if (!next.some((entry) => samePath(entry, canonicalPath))) next.push(canonicalPath);
  return next.filter((entry, index) => next.indexOf(entry) === index);
}

// Stable fallback: a fresh [] per render makes the zustand selector loop.
const NO_WORKSPACES: string[] = [];

export function WorkspacePicker() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const knownWorkspaces = useAppStore((s) => s.desktopSettings?.knownWorkspaces ?? NO_WORKSPACES);
  const switchTarget = useAppStore((s) => s.workspaceSwitchTarget);
  const workspaceActivities = useAppStore((s) => s.workspaceActivities);
  const setWorkspaceActivities = useAppStore((s) => s.setWorkspaceActivities);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const setSession = useAppStore((s) => s.setSession);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [pending, setPending] = useState(false);
  const [collapsed, setCollapsed] = useState(() =>
    sidebarPref("pideck.sidebar.workspacesCollapsed"),
  );
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [telegramDialogOpen, setTelegramDialogOpen] = useState(false);
  const requestRef = useRef(0);

  function toggleCollapsed() {
    setCollapsed((current) => {
      setSidebarPref("pideck.sidebar.workspacesCollapsed", !current);
      return !current;
    });
  }

  const currentCwd = workspace?.canonicalCwd ?? null;
  const requestedCwd = workspace?.cwd ?? null;

  // Self-heal: whatever workspace is active (restored, picked, or set by the
  // host) always appears in the persistent list.
  useEffect(() => {
    if (!currentCwd) return;
    const next = replaceKnownWorkspace(knownWorkspaces, requestedCwd ?? currentCwd, currentCwd);
    if (
      next.length === knownWorkspaces.length &&
      next.every((entry, index) => entry === knownWorkspaces[index])
    ) {
      return;
    }
    void persistDesktopSettings({
      knownWorkspaces: next,
    }).catch(notifyDesktopSettingsSaveFailure);
  }, [currentCwd, knownWorkspaces, requestedCwd]);

  // Live activity for every workspace Host in the pool, including background
  // ones whose stdout is not routed to the renderer. Refetch on mount, on
  // workspace/host changes, and whenever a Host emits a busy-change signal.
  useEffect(() => {
    let alive = true;
    let latestRefresh = 0;
    const refresh = async () => {
      const request = ++latestRefresh;
      const list = await fetchHostActivity();
      if (!alive || request !== latestRefresh) return;
      const activities = Object.fromEntries(
        list.map((entry) => [
          normalizedActivityKey(entry.cwd),
          {
            busy: entry.busy,
            hasBeenBusy: entry.hasBeenBusy,
            errorCount: entry.errorCount,
            doneCount: entry.doneCount,
            terminalSessions: entry.terminalSessions ?? {},
          },
        ]),
      );
      const current = useAppStore.getState();
      const currentWorkspace = current.workspace;
      if (currentWorkspace) {
        const active = activities[normalizedActivityKey(currentWorkspace.canonicalCwd)];
        if (active) {
          current.mergeSessionTerminalSnapshots(currentWorkspace.id, active.terminalSessions);
        }
      }
      setWorkspaceActivities(activities);
    };
    void refresh();
    const unsubscribe = subscribeHostActivity(() => void refresh());
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [setWorkspaceActivities, workspace?.id, host?.hostInstanceId]);

  async function switchTo(cwd: string) {
    if (!host || pending) return;
    if (currentCwd && samePath(currentCwd, cwd)) return;

    const request = ++requestRef.current;
    setPending(true);
    useAppStore.getState().setWorkspaceSwitchTarget(cwd);
    const currentPage = useAppStore.getState().page;
    if (currentPage !== "chat") useAppStore.getState().setPage("chat");
    try {
      const connectDedicatedHost = async (force: boolean): Promise<boolean> => {
        const activated = force
          ? await activateWorkspaceHost(cwd)
          : await prepareWorkspaceHost(cwd, workspaceHasActiveAgent(useAppStore.getState()));
        if (!activated) return false;
        hostClient.prepareForHostSwitch();
        useAppStore.getState().setConnecting(true);
        await replayActiveHostReady();
        await waitForWorkspaceActivation(host.hostInstanceId);
        return true;
      };
      if (await connectDedicatedHost(false)) {
        return;
      }

      const res = await hostClient.request(
        "workspace.setCurrent",
        workspaceContext(host, workspace),
        { cwd },
        60_000,
      );

      if (request !== requestRef.current) return;
      if (!res.ok) {
        if (isWorkspaceSwitchBusyError(res.error) && (await connectDedicatedHost(true))) return;
        pushNotification(localizeHostError(res.error, t), "error");
        return;
      }

      const result = res.result;
      await rebindActiveWorkspaceHost(result.workspace.canonicalCwd);
      // workspace.changed / session.snapshot events land before this response
      // resolves; re-applying identical snapshots re-renders the chat and
      // sidebar a second time. Apply only what the event stream has not.
      const appliedWorkspace = useAppStore.getState().workspace;
      if (
        appliedWorkspace === null ||
        appliedWorkspace.id !== result.workspace.id ||
        appliedWorkspace.revision !== result.workspace.revision
      ) {
        setWorkspace(result.workspace);
      }
      const responseSession = result.session;
      if (responseSession) {
        const appliedSession = useAppStore.getState().session;
        if (
          appliedSession === null ||
          appliedSession.sessionId !== responseSession.sessionId ||
          appliedSession.revision !== responseSession.revision
        ) {
          setSession(responseSession);
        }
      }
      useAppStore.getState().setHost({
        ...host,
        workspaceId: res.workspaceId,
        workspaceRevision: res.workspaceRevision,
        sessionId: res.sessionId,
        sessionRevision: res.sessionRevision,
        packageRevision: res.packageRevision,
      });
    } finally {
      if (request === requestRef.current) {
        setPending(false);
        useAppStore.getState().setWorkspaceSwitchTarget(null);
      }
    }
  }

  async function pickAndAdd() {
    if (!host || pending) return;
    let cwd: string | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") cwd = selected;
    } catch {
      cwd = window.prompt(t("workspacesEnterPath")) || null;
    }
    if (!cwd) return;
    await switchTo(cwd);
  }

  function removeFromList(path: string) {
    void persistDesktopSettings({
      knownWorkspaces: removeKnownWorkspace(knownWorkspaces, path),
    }).catch(notifyDesktopSettingsSaveFailure);
  }

  // Render the active workspace even before self-heal persists it.
  const listed = currentCwd ? addKnownWorkspace(knownWorkspaces, currentCwd) : knownWorkspaces;

  return (
    <section>
      <div className="mb-1 flex h-7 items-center justify-between px-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls="workspace-list-region"
          title={collapsed ? t("workspacesExpand") : t("workspacesCollapse")}
          className="group flex min-w-0 items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-foreground"
        >
          <span>{t("workspacesTitle")}</span>
          <ChevronDown
            size={12}
            className={`opacity-0 transition-all group-hover:opacity-100 ${
              collapsed ? "-rotate-90" : ""
            }`}
          />
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setAddMenuOpen((v) => !v)}
            disabled={!host || pending}
            className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
            title={t("botAddMenu")}
            aria-label={t("botAddMenu")}
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
          >
            <Plus size={15} />
          </button>
          {addMenuOpen && (
            <div
              className="absolute right-0 top-9 z-30 w-60 rounded-md border border-border bg-surface-raised p-1 shadow-xl"
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-overlay"
                onClick={() => {
                  setAddMenuOpen(false);
                  void pickAndAdd();
                }}
              >
                <FolderPlus size={16} className="mt-0.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    {t("botAddFolderWorkspace")}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {t("botAddFolderWorkspaceDesc")}
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-overlay"
                onClick={() => {
                  setAddMenuOpen(false);
                  setTelegramDialogOpen(true);
                }}
              >
                <Send size={16} className="mt-0.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    {t("botAddTelegramBot")}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {t("botAddTelegramBotDesc")}
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled
                className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
              >
                <MessageCircle size={16} className="mt-0.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    {t("botAddWeixinBot")}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {t("botAddWeixinBotDesc")}
                  </span>
                </span>
                <span className="mt-0.5 shrink-0 rounded bg-surface-overlay px-1.5 py-0.5 text-[10px] text-muted">
                  {t("botAddComingSoon")}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
      <CollapsibleRegion open={!collapsed} id="workspace-list-region">
        {listed.length === 0 ? (
          <button
            type="button"
            onClick={() => void pickAndAdd()}
            disabled={!host || pending}
            className="interface-density-nav-row flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
          >
            <FolderPlus size={16} />
            <span>{pending ? t("workspacesOpening") : t("workspacesAdd")}</span>
          </button>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {listed.map((path) => {
              const active = Boolean(currentCwd && samePath(currentCwd, path));
              const activity = workspaceActivities[normalizedActivityKey(path)];
              // Priority: red (unacknowledged failure) > green (busy) > gray
              // (unacknowledged completion) > none. Returning to the sessions
              // acknowledges their markers, so the dot downgrades over time.
              const statusDot =
                activity && activity.errorCount > 0
                  ? "bg-danger status-dot-pulse"
                  : activity?.busy
                    ? "bg-success status-dot-pulse"
                    : activity && activity.doneCount > 0
                      ? "bg-muted status-dot-pulse"
                      : active && !workspace?.servicesReady
                        ? "bg-warning status-dot-pulse"
                        : null;
              return (
                <li
                  key={path}
                  className={`interface-density-nav-row group flex h-9 items-center rounded-md text-[13px] ${
                    active ? "bg-surface-overlay font-medium" : "hover:bg-surface-overlay/70"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void switchTo(path)}
                    disabled={!host || pending || active}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
                    title={`${workspaceDisplayName(path)}\n${path}`}
                    aria-current={active ? "true" : undefined}
                  >
                    {pending && switchTarget !== null && samePath(switchTarget, path) ? (
                      <LoaderCircle size={16} className="shrink-0 animate-spin text-muted" />
                    ) : (
                      <Folder
                        size={16}
                        className={`shrink-0 ${active ? "text-accent" : "text-muted"}`}
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{workspaceDisplayName(path)}</span>
                    {statusDot && (
                      <span className={`size-[8.2px] shrink-0 rounded-full ${statusDot}`} />
                    )}
                  </button>
                  {!active && (
                    <button
                      type="button"
                      onClick={() => removeFromList(path)}
                      disabled={pending}
                      className="mr-1 hidden rounded p-1 text-muted hover:bg-surface hover:text-foreground group-hover:block"
                      title={t("workspacesRemoveTitle")}
                      aria-label={t("workspacesRemoveAria", { name: workspaceDisplayName(path) })}
                    >
                      <X size={13} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CollapsibleRegion>
      {telegramDialogOpen && (
        <TelegramAddDialog
          onCancel={() => setTelegramDialogOpen(false)}
          onConfirm={(gateway: BotGateway) => {
            addGateway(gateway);
            setTelegramDialogOpen(false);
            pushNotification(t("botAddTelegramSaved", { name: gateway.name }), "success");
          }}
        />
      )}
    </section>
  );
}
