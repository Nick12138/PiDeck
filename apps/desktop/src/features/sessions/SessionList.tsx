import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { tCurrent, useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { persistDesktopSettings } from "../../lib/desktop-settings";
import {
  prioritizePinnedSessions,
  readPinnedSessionIds,
  writePinnedSessionIds,
} from "../../lib/session-pins";
import {
  captureRequestGeneration,
  activeSessionContext,
  isCurrentRequestGeneration,
  mergeHostIdentity,
  nullableSessionContext,
  workspaceContext,
} from "../../lib/bridge/host-context";
import type { SessionSnapshot, SessionSummary } from "@pideck/protocol";
import {
  LatestSessionOpenQueue,
  requestSessionOpenWithRetry,
  SESSION_OPEN_TIMEOUT_MS,
} from "../../lib/bridge/session-open-request";
import {
  sessionCatalogItems,
  type SessionCatalogEntry,
  type SessionRuntimeState,
} from "../../lib/stores/session-catalog";

export type SessionFilter = "active" | "archived";

type SessionConfirmAction =
  | { kind: "delete"; item: SessionCatalogEntry }
  | { kind: "cleanup"; count: number };

export function includeActiveSession(
  items: SessionSummary[],
  active: SessionSnapshot | null,
): SessionSummary[] {
  if (!active?.sessionPath || active.messages.length === 0) return items;
  const listed = items.find((item) => item.sessionId === active.sessionId);
  const current: SessionSummary = {
    sessionId: active.sessionId,
    sessionPath: active.sessionPath,
    name: active.name,
    cwd: active.cwd,
    updatedAt: listed?.updatedAt ?? Date.now(),
    messageCount: active.messages.length,
  };
  return [current, ...items.filter((item) => item.sessionId !== active.sessionId)];
}

export function sessionDisplayName(
  item: Pick<SessionSummary, "name">,
  fallback = "新会话",
): string {
  return item.name?.trim() || fallback;
}

export function sessionRuntimeLabel(state: SessionRuntimeState): string {
  return state;
}

/** Dot color class for states worth surfacing; quiet states render nothing. */
export function sessionStatusDotClass(state: SessionRuntimeState): string | null {
  switch (state) {
    case "running":
      return "bg-success animate-pulse";
    case "queued":
      return "bg-warning";
    case "error":
      return "bg-danger";
    default:
      return null;
  }
}

export function filterSessionItems(
  items: SessionCatalogEntry[],
  query: string,
  filter: SessionFilter,
): SessionCatalogEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filter === "archived" ? !item.archived : item.archived) return false;
    if (!normalizedQuery) return true;
    return [sessionDisplayName(item), item.cwd, item.sessionId]
      .join("\n")
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
}

export function canReloadSession(
  item: SessionCatalogEntry,
  session: SessionSnapshot | null,
): boolean {
  return Boolean(
    !item.archived &&
      session?.sessionId === item.sessionId &&
      session.sessionPath &&
      session.isIdle,
  );
}

export function canRenameSession(
  item: SessionCatalogEntry,
  session: SessionSnapshot | null,
): boolean {
  if (session?.sessionId === item.sessionId) return session.isIdle;
  return item.runtimeState === "inactive" || item.runtimeState === "error";
}

/** Busy states cover a run that is active or about to start; everything else is safe to mutate. */
export function isSessionRuntimeBusy(state: SessionRuntimeState): boolean {
  return state === "starting" || state === "running" || state === "queued";
}

export function canArchiveSession(
  item: SessionCatalogEntry,
  session: SessionSnapshot | null,
): boolean {
  if (item.archived) return false;
  if (session?.sessionId === item.sessionId) return session.isIdle;
  return !isSessionRuntimeBusy(item.runtimeState);
}

export function canDeleteSession(
  item: SessionCatalogEntry,
  session: SessionSnapshot | null,
): boolean {
  if (item.archived) return true;
  if (session?.sessionId === item.sessionId) return session.isIdle;
  return !isSessionRuntimeBusy(item.runtimeState);
}

export function shouldClearLastSessionPath(
  lastSessionPath: string,
  removedSessionPath: string,
): boolean {
  return lastSessionPath === removedSessionPath;
}

export function shouldRetrySessionRpc(error: {
  code?: string;
  retryable?: boolean;
}): boolean {
  return error.code === "SERVICE_GRAPH_BUSY" && error.retryable === true;
}

/** Short-lived sdk.read locks make SERVICE_GRAPH_BUSY transient; retry briefly. */
export async function requestSessionRpcWithRetry<
  T extends
    | { ok: true }
    | { ok: false; error: { code?: string; retryable?: boolean } },
>(
  request: () => Promise<T>,
  wait: (delayMs: number) => Promise<unknown> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request();
    if (response.ok || !shouldRetrySessionRpc(response.error) || attempt === 4) {
      return response;
    }
    await wait(80 * (attempt + 1));
  }
}

export function SessionList({
  showCreateAction = true,
  collapsed = false,
  onToggleCollapsed,
}: {
  showCreateAction?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const connecting = useAppStore((s) => s.connecting);
  const rehydrating = useAppStore((s) => s.rehydrating);
  const desynchronized = useAppStore((s) => s.desynchronized);
  const hostFatal = useAppStore((s) => s.hostFatal);
  const sessionCatalog = useAppStore((s) => s.sessionCatalog);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const replaceSessionCatalog = useAppStore((s) => s.replaceSessionCatalog);
  const clearSessionCatalog = useAppStore((s) => s.clearSessionCatalog);
  const setSessionRuntimeState = useAppStore((s) => s.setSessionRuntimeState);
  const updateSessionCatalogInfo = useAppStore((s) => s.updateSessionCatalogInfo);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [sessionMutationPending, setSessionMutationPending] = useState(false);
  const [sessionOpenPending, setSessionOpenPending] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("active");
  const [controlsOpen, setControlsOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(
    null,
  );
  const [confirmAction, setConfirmAction] = useState<SessionConfirmAction | null>(null);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>(() =>
    readPinnedSessionIds(useAppStore.getState().workspace?.id),
  );
  const sessionOpenBlocked = connecting || rehydrating || desynchronized || Boolean(hostFatal);
  const sessionMutationBlocked =
    sessionMutationPending || sessionOpenPending || sessionOpenBlocked;
  const refreshRequest = useRef(0);
  const mutationRequest = useRef(0);
  const itemsWorkspaceId = useRef<string | null>(null);
  const mounted = useRef(true);
  const performSessionOpenRef = useRef(performSessionOpen);
  performSessionOpenRef.current = performSessionOpen;
  const sessionOpenQueue = useRef<LatestSessionOpenQueue | null>(null);
  if (!sessionOpenQueue.current) {
    sessionOpenQueue.current = new LatestSessionOpenQueue(
      (path, isSuperseded) => performSessionOpenRef.current(path, isSuperseded),
      (running) => {
        if (mounted.current) setSessionOpenPending(running);
      },
      (error) => {
        const message =
          error instanceof Error ? error.message : tCurrent("notifOpenSessionFailed");
        useAppStore.getState().pushNotification(message, "error");
      },
    );
  }

  const refresh = useCallback(async () => {
    const currentAtStart = useAppStore.getState();
    const currentHost = currentAtStart.host;
    const currentWorkspace = currentAtStart.workspace;
    if (!currentHost || !currentWorkspace?.servicesReady) {
      refreshRequest.current += 1;
      itemsWorkspaceId.current = null;
      clearSessionCatalog();
      return;
    }
    if (
      currentAtStart.connecting ||
      currentAtStart.rehydrating ||
      currentAtStart.desynchronized
    ) {
      refreshRequest.current += 1;
      return;
    }
    if (itemsWorkspaceId.current !== currentWorkspace.id) {
      itemsWorkspaceId.current = currentWorkspace.id;
    }
    const request = ++refreshRequest.current;
    const expectedHostId = currentHost.hostInstanceId;
    const expectedWorkspaceId = currentWorkspace.id;
    const expectedWorkspaceRevision = currentWorkspace.revision;
    try {
      const res = await requestSessionRpcWithRetry(() =>
        hostClient.request(
          "session.list",
          workspaceContext(currentHost, currentWorkspace),
          null,
        ),
      );
      const current = useAppStore.getState();
      if (
        request !== refreshRequest.current ||
        current.host?.hostInstanceId !== expectedHostId ||
        current.workspace?.id !== expectedWorkspaceId ||
        current.workspace?.revision !== expectedWorkspaceRevision
      ) {
        return;
      }
      if (res.ok) {
        itemsWorkspaceId.current = expectedWorkspaceId;
        replaceSessionCatalog(expectedWorkspaceId, res.result.items);
      }
    } catch {
      return;
    }
  }, [
    clearSessionCatalog,
    replaceSessionCatalog,
  ]);

  useEffect(() => {
    void refresh();
  }, [
    connecting,
    desynchronized,
    host?.hostInstanceId,
    refresh,
    rehydrating,
    workspace?.id,
    workspace?.revision,
    workspace?.servicesReady,
  ]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sessionOpenQueue.current?.clearPending();
    };
  }, []);

  useEffect(() => {
    sessionOpenQueue.current?.clearPending();
    setPinnedSessionIds(readPinnedSessionIds(workspace?.id));
    setEditingSessionId(null);
    setNameDraft("");
    setMenuSessionId(null);
    setMenuPosition(null);
  }, [workspace?.id]);

  useEffect(() => {
    if (!menuSessionId) return;
    const closeSessionMenu = () => {
      setMenuSessionId(null);
      setMenuPosition(null);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest("[data-session-menu]")
      ) {
        closeSessionMenu();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", closeSessionMenu);
    window.addEventListener("scroll", closeSessionMenu, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", closeSessionMenu);
      window.removeEventListener("scroll", closeSessionMenu, true);
    };
  }, [menuSessionId]);

  async function createSession() {
    if (!host || !workspace || sessionMutationBlocked) return;
    const request = ++mutationRequest.current;
    setSessionMutationPending(true);
    try {
      await requestFreshSession(request);
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  /** Create and adopt a fresh session; false when it failed or the request was superseded. */
  async function requestFreshSession(request: number): Promise<boolean> {
    const { host: startHost, workspace: startWorkspace } = useAppStore.getState();
    if (!startHost || !startWorkspace) return false;
    const generation = captureRequestGeneration(startHost);
    const res = await requestSessionRpcWithRetry(() =>
      hostClient.request(
        "session.create",
        nullableSessionContext(startHost, startWorkspace),
        {},
      ),
    );
    // The create's own session.snapshot push may advance the session generation
    // before this response resolves, so only host and workspace are validated here.
    if (
      request !== mutationRequest.current ||
      !isCurrentRequestGeneration(useAppStore.getState().host, generation)
    ) {
      return false;
    }
    if (!res.ok) {
      pushNotification(res.error?.message ?? t("notifCreateSessionFailed"), "error");
      return false;
    }
    setSession(res.result);
    const currentHost = useAppStore.getState().host;
    if (currentHost) {
      const nextHost = mergeHostIdentity(currentHost, res);
      if (nextHost) useAppStore.getState().setHost(nextHost);
    }
    return true;
  }

  function openSession(path: string) {
    const current = useAppStore.getState();
    if (
      !current.host ||
      !current.workspace ||
      sessionMutationPending ||
      sessionOpenBlocked
    ) {
      return;
    }
    if (!sessionOpenQueue.current?.isRunning() && current.session?.sessionPath === path) {
      return;
    }
    sessionOpenQueue.current?.enqueue(path);
  }

  async function performSessionOpen(
    path: string,
    isSuperseded: () => boolean,
  ): Promise<void> {
    const currentAtStart = useAppStore.getState();
    const currentHost = currentAtStart.host;
    const currentWorkspace = currentAtStart.workspace;
    if (
      !currentHost ||
      !currentWorkspace ||
      currentAtStart.connecting ||
      currentAtStart.rehydrating ||
      currentAtStart.desynchronized ||
      currentAtStart.session?.sessionPath === path
    ) {
      return;
    }
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(currentHost);
    const target = sessionCatalogItems(currentAtStart.sessionCatalog).find(
      (item) => item.sessionPath === path,
    );
    const startedAt = performance.now();
    try {
      const openContext = nullableSessionContext(currentHost, currentWorkspace);
      const res = await requestSessionOpenWithRetry(
        () =>
          hostClient.request(
            "session.open",
            openContext,
            { sessionPath: path },
            SESSION_OPEN_TIMEOUT_MS,
          ),
        undefined,
        () => {
          const current = useAppStore.getState();
          return (
            !isSuperseded() &&
            current.host?.hostInstanceId === openContext.expectedHostInstanceId &&
            current.workspace?.id === openContext.expectedWorkspaceId &&
            current.workspace?.revision === openContext.expectedWorkspaceRevision
          );
        },
      );
      if (!res) return;
      console.info(
        `[session] open took ${Math.round(performance.now() - startedAt)}ms ok=${res.ok}`,
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        if (isSuperseded()) return;
        if (target && res.error?.retryable !== true) {
          setSessionRuntimeState(
            target.sessionId,
            "error",
            res.error?.message ?? t("notifOpenSessionFailed"),
          );
        }
        pushNotification(
          res.error?.message ?? t("notifOpenSessionFailed"),
          res.error?.retryable === true ? "warning" : "error",
        );
        return;
      }
      setSession(res.result);
      const latestHost = useAppStore.getState().host;
      if (latestHost) {
        const nextHost = mergeHostIdentity(latestHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
    } catch (error) {
      if (isSuperseded()) return;
      const message =
        error instanceof Error ? error.message : t("notifOpenSessionFailed");
      if (target) setSessionRuntimeState(target.sessionId, "error", message);
      pushNotification(message, "error");
    }
  }

  function beginRename(item: SessionCatalogEntry) {
    if (!canRenameSession(item, session) || sessionMutationBlocked) return;
    setMenuSessionId(null);
    setEditingSessionId(item.sessionId);
    setNameDraft(sessionDisplayName(item, t("sessionsUntitled")));
  }

  function cancelRename() {
    setEditingSessionId(null);
    setNameDraft("");
  }

  async function renameSession() {
    if (!host || !workspace || !editingSessionId || sessionMutationBlocked) return;
    const item = sessionCatalogItems(sessionCatalog).find(
      (entry) => entry.sessionId === editingSessionId,
    );
    if (!item || !canRenameSession(item, session)) return;
    const name = nameDraft.trim();
    if (!name) {
      pushNotification(t("notifSessionNameEmpty"), "error");
      return;
    }
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(host);
    setSessionMutationPending(true);
    try {
      const res = await hostClient.request(
        "session.rename",
        workspaceContext(host, workspace),
        { sessionId: item.sessionId, sessionPath: item.sessionPath, name },
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? t("notifRenameFailed"), "error");
        return;
      }
      updateSessionCatalogInfo(res.result.sessionId, res.result.name);
      if (res.result.session) setSession(res.result.session);
      cancelRename();
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifRenameFailed"),
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  function togglePinnedSession(item: SessionCatalogEntry) {
    if (!workspace) return;
    setPinnedSessionIds((current) => {
      const next = current.includes(item.sessionId)
        ? current.filter((sessionId) => sessionId !== item.sessionId)
        : [...current, item.sessionId];
      writePinnedSessionIds(workspace.id, next);
      return next;
    });
    setMenuSessionId(null);
  }

  function removePinnedSessions(sessionIds: readonly string[]) {
    if (!workspace || sessionIds.length === 0) return;
    const removed = new Set(sessionIds);
    setPinnedSessionIds((current) => {
      const next = current.filter((sessionId) => !removed.has(sessionId));
      writePinnedSessionIds(workspace.id, next);
      return next;
    });
  }

  async function runSessionFileAction(
    method: "session.archive" | "session.restore",
    item: SessionCatalogEntry,
  ) {
    if (!host || !workspace || sessionMutationBlocked) return;
    const currentSession = useAppStore.getState().session;
    if (method === "session.archive" && !canArchiveSession(item, currentSession)) {
      pushNotification(t("sessionsArchiveWait"), "warning");
      setMenuSessionId(null);
      return;
    }
    const request = ++mutationRequest.current;
    setSessionMutationPending(true);
    setMenuSessionId(null);
    try {
      if (
        method === "session.archive" &&
        currentSession?.sessionId === item.sessionId &&
        !(await requestFreshSession(request))
      ) {
        return;
      }
      const { host: latestHost, workspace: latestWorkspace } = useAppStore.getState();
      if (!latestHost || !latestWorkspace) return;
      const generation = captureRequestGeneration(latestHost);
      const res = await requestSessionRpcWithRetry(() =>
        hostClient.request(
          method,
          workspaceContext(latestHost, latestWorkspace),
          {
            sessionId: item.sessionId,
            sessionPath: item.sessionPath,
          },
        ),
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(
          res.error?.message ?? t("notifSessionFileOpFailed"),
          "error",
        );
        return;
      }
      if (method === "session.archive") {
        const lastSessionPath = useAppStore.getState().desktopSettings?.lastSessionPath;
        if (
          lastSessionPath &&
          shouldClearLastSessionPath(lastSessionPath, item.sessionPath)
        ) {
          await persistDesktopSettings({ lastSessionPath: null });
        }
      }
      await refresh();
      pushNotification(
        method === "session.archive"
          ? t("notifSessionArchived")
          : t("notifSessionRestored"),
        "success",
      );
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifSessionFileOpFailed"),
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  async function deleteSessionPermanently(item: SessionCatalogEntry) {
    if (!host || !workspace || sessionMutationBlocked) return;
    const currentSession = useAppStore.getState().session;
    if (!canDeleteSession(item, currentSession)) {
      pushNotification(t("sessionsDeleteWait"), "warning");
      setConfirmAction(null);
      return;
    }

    const request = ++mutationRequest.current;
    setSessionMutationPending(true);
    setMenuSessionId(null);
    try {
      if (
        !item.archived &&
        currentSession?.sessionId === item.sessionId &&
        !(await requestFreshSession(request))
      ) {
        return;
      }
      const { host: latestHost, workspace: latestWorkspace } = useAppStore.getState();
      if (!latestHost || !latestWorkspace) return;
      const generation = captureRequestGeneration(latestHost);
      const deleted = await requestSessionRpcWithRetry(() =>
        hostClient.request(
          "session.delete",
          workspaceContext(latestHost, latestWorkspace),
          { sessionId: item.sessionId, sessionPath: item.sessionPath },
        ),
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!deleted.ok) {
        if (deleted.error?.code === "SESSION_NOT_FOUND") {
          await refresh();
          removePinnedSessions([item.sessionId]);
          setConfirmAction(null);
          pushNotification(t("notifSessionGone"), "warning");
          return;
        }
        pushNotification(
          deleted.error?.message ?? t("notifSessionDeleteFailed"),
          "error",
        );
        return;
      }

      const lastSessionPath = useAppStore.getState().desktopSettings?.lastSessionPath;
      if (
        lastSessionPath &&
        shouldClearLastSessionPath(lastSessionPath, item.sessionPath)
      ) {
        await persistDesktopSettings({ lastSessionPath: null });
      }
      await refresh();
      removePinnedSessions([item.sessionId]);
      setConfirmAction(null);
      pushNotification(t("notifSessionDeleted"), "success");
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifSessionDeleteFailed"),
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  async function cleanupArchivedSessions() {
    if (!host || !workspace || sessionMutationBlocked) return;
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(host);
    setSessionMutationPending(true);
    try {
      const res = await hostClient.request(
        "session.cleanupArchived",
        workspaceContext(host, workspace),
        null,
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? t("notifCleanupFailed"), "error");
        return;
      }
      await refresh();
      const remainingSessionIds = new Set(
        sessionCatalogItems(useAppStore.getState().sessionCatalog).map(
          (item) => item.sessionId,
        ),
      );
      removePinnedSessions(
        sessionCatalogItems(sessionCatalog)
          .filter((item) => item.archived && !remainingSessionIds.has(item.sessionId))
          .map((item) => item.sessionId),
      );
      setConfirmAction(null);
      pushNotification(
        res.result.failedCount > 0
          ? t("notifCleanupPartial", {
              deleted: res.result.deletedCount,
              failed: res.result.failedCount,
            })
          : t("notifCleanupDone", { deleted: res.result.deletedCount }),
        res.result.failedCount > 0 ? "warning" : "success",
      );
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifCleanupFailed"),
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  async function reloadSessionFromDisk() {
    if (!host || !workspace || !session || sessionMutationBlocked || !session.isIdle) {
      return;
    }
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(host);
    setSessionMutationPending(true);
    setMenuSessionId(null);
    try {
      const res = await hostClient.request(
        "session.reload",
        activeSessionContext(host, workspace, session),
        null,
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? t("notifSessionReloadFailed"), "error");
        return;
      }
      setSession(res.result);
      const currentHost = useAppStore.getState().host;
      if (currentHost) {
        const nextHost = mergeHostIdentity(currentHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
      pushNotification(t("notifSessionReloaded"), "success");
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifSessionReloadFailed"),
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  const allItems = prioritizePinnedSessions(
    sessionCatalogItems(sessionCatalog),
    pinnedSessionIds,
  );
  const visibleItems = filterSessionItems(allItems, query, filter);
  const archivedCount = allItems.filter((item) => item.archived).length;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-8 items-center justify-between px-2">
        {onToggleCollapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            title={collapsed ? t("sessionsExpand") : t("sessionsCollapse")}
            className="group flex min-w-0 items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-foreground"
          >
            <span>{t("sessionsRecent")}</span>
            <ChevronDown
              size={12}
              className={`opacity-0 transition-all group-hover:opacity-100 ${
                collapsed ? "rotate-180" : ""
              }`}
            />
          </button>
        ) : (
          <span className="text-[11px] font-medium text-muted">{t("sessionsRecent")}</span>
        )}
        <div className="flex items-center gap-0.5">
          {archivedCount > 0 && (
            <button
              type="button"
              title={t("sessionsClearArchivedTitle", { count: archivedCount })}
              aria-label={t("sessionsClearArchivedAria")}
              className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-danger"
              onClick={() => setConfirmAction({ kind: "cleanup", count: archivedCount })}
              disabled={sessionMutationBlocked}
            >
              <Trash2 size={13} />
            </button>
          )}
          <button
            type="button"
            title={t("sessionsSearchFilterTitle")}
            aria-label={t("sessionsSearchFilterTitle")}
            className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-foreground"
            onClick={() => setControlsOpen((open) => !open)}
          >
            <Search size={14} />
          </button>
          {showCreateAction && <button
            type="button"
            title={t("sessionsNew")}
            className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-foreground"
            onClick={() => void createSession()}
            disabled={!workspace?.servicesReady || sessionMutationBlocked}
          >
            <Plus size={14} />
          </button>}
        </div>
      </div>
      {collapsed ? null : (
        <>
      {!workspace?.servicesReady && (
        <p className="px-1 text-xs text-muted">{t("sessionsSelectWorkspaceFirst")}</p>
      )}
      {workspace?.servicesReady && (controlsOpen || Boolean(query) || filter !== "active") && (
        <div className="flex gap-1 px-1">
          <label className="relative min-w-0 flex-1">
            <Search
              size={13}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              type="search"
              aria-label={t("sessionsSearchAria")}
              placeholder={t("sessionsSearchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-7 w-full rounded-md border border-border bg-surface pl-7 pr-2 text-xs outline-none focus:border-accent"
            />
          </label>
          <div
            role="group"
            aria-label={t("sessionsFilterAria")}
            className="flex h-7 shrink-0 overflow-hidden rounded-md border border-border text-xs"
          >
            <button
              type="button"
              onClick={() => setFilter("active")}
              aria-pressed={filter === "active"}
              className={`px-2 transition-colors ${
                filter === "active"
                  ? "bg-surface-overlay text-foreground"
                  : "bg-surface text-muted hover:text-foreground"
              }`}
            >
              {t("sessionsFilterActive")}
            </button>
            <button
              type="button"
              onClick={() => setFilter("archived")}
              aria-pressed={filter === "archived"}
              className={`border-l border-border px-2 transition-colors ${
                filter === "archived"
                  ? "bg-surface-overlay text-foreground"
                  : "bg-surface text-muted hover:text-foreground"
              }`}
            >
              {archivedCount > 0
                ? t("sessionsFilterArchivedCount", { count: archivedCount })
                : t("sessionsFilterArchived")}
            </button>
          </div>
        </div>
      )}
      <ul className="flex flex-col gap-0.5">
        {visibleItems.map((item) => {
          const active = !item.archived && session?.sessionId === item.sessionId;
          const editing = editingSessionId === item.sessionId;
          const menuOpen = menuSessionId === item.sessionId;
          const pinned = pinnedSessionIds.includes(item.sessionId);
          const canRename = canRenameSession(item, session);
          const canDelete = canDeleteSession(item, session);
          const canReload = canReloadSession(item, session);
          const canArchive = canArchiveSession(item, session);
          const statusDot = item.archived
            ? null
            : sessionStatusDotClass(item.runtimeState);
          return (
            <li
              key={item.sessionId}
              className={`group flex h-9 items-center rounded-md text-[13px] ${
                active ? "bg-surface-overlay text-foreground" : "hover:bg-surface-overlay/70"
              }`}
            >
              {editing ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void renameSession();
                  }}
                >
                  <input
                    autoFocus
                    aria-label={t("sessionsNameAria")}
                    value={nameDraft}
                    maxLength={120}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") cancelRename();
                    }}
                    className="h-7 min-w-0 flex-1 rounded border border-accent bg-surface px-1.5 text-xs text-foreground outline-none"
                  />
                  <button
                    type="submit"
                    title={t("sessionsSaveName")}
                    disabled={sessionMutationBlocked || !nameDraft.trim()}
                    className="rounded p-1 text-accent hover:bg-surface-overlay disabled:opacity-40"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    title={t("sessionsCancelRename")}
                    onClick={cancelRename}
                    disabled={sessionMutationBlocked}
                    className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
                  >
                    <X size={14} />
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => openSession(item.sessionPath)}
                    disabled={
                      sessionMutationPending ||
                      sessionOpenBlocked ||
                      !item.sessionPath ||
                      item.archived
                    }
                    className="min-w-0 flex-1 px-2.5 py-2 text-left"
                    title={
                      item.runtimeState === "error" && item.lastError
                        ? `${sessionDisplayName(item, t("sessionsUntitled"))} — ${item.lastError}`
                        : sessionDisplayName(item, t("sessionsUntitled"))
                    }
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={`truncate ${active ? "font-medium" : ""}`}>
                        {sessionDisplayName(item, t("sessionsUntitled"))}
                      </span>
                      {pinned && (
                        <Pin
                          size={10}
                          aria-label={t("sessionsPinned")}
                          className="shrink-0 text-muted"
                        />
                      )}
                    </div>
                  </button>
                  <div
                    className="relative mr-1 flex size-[22px] shrink-0 items-center justify-center"
                    data-session-menu
                  >
                    {statusDot && (
                      <span
                        aria-label={sessionRuntimeLabel(item.runtimeState)}
                        className={`pointer-events-none absolute flex size-1.5 transition-opacity ${
                          menuOpen
                            ? "opacity-0"
                            : "opacity-100 group-hover:opacity-0 group-focus-within:opacity-0"
                        }`}
                      >
                        <span className={`size-1.5 rounded-full ${statusDot}`} />
                      </span>
                    )}
                    <button
                      type="button"
                      title={t("sessionsActionsTitle")}
                      aria-label={t("sessionsActionsTitle")}
                      aria-expanded={menuOpen}
                      onClick={(event) => {
                        if (menuOpen) {
                          setMenuSessionId(null);
                          setMenuPosition(null);
                          return;
                        }
                        const rect = event.currentTarget.getBoundingClientRect();
                        const menuWidth = 144;
                        const menuHeight = 166;
                        const viewportPadding = 8;
                        const below = rect.bottom + 4;
                        setMenuPosition({
                          left: Math.max(
                            viewportPadding,
                            Math.min(
                              rect.right - menuWidth,
                              window.innerWidth - menuWidth - viewportPadding,
                            ),
                          ),
                          top:
                            below + menuHeight <= window.innerHeight - viewportPadding
                              ? below
                              : Math.max(viewportPadding, rect.top - menuHeight - 4),
                        });
                        setMenuSessionId(item.sessionId);
                      }}
                      disabled={sessionMutationBlocked}
                      className={`rounded p-1 text-muted transition-opacity hover:bg-surface hover:text-foreground ${
                        menuOpen
                          ? "opacity-100 disabled:opacity-30"
                          : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:disabled:opacity-30 group-focus-within:disabled:opacity-30"
                      }`}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                    {menuOpen && menuPosition && (
                      <div
                        className="fixed z-50 w-36 rounded-md border border-border bg-surface-raised p-1 shadow-lg"
                        style={menuPosition}
                        data-session-menu
                      >
                        <button
                          type="button"
                          title={
                            canRename ? t("sessionsRenameTitle") : t("sessionsRenameWait")
                          }
                          disabled={!canRename}
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => beginRename(item)}
                        >
                          <Pencil size={13} />
                          {t("sessionsRename")}
                        </button>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay"
                          onClick={() => togglePinnedSession(item)}
                        >
                          {pinned ? <PinOff size={13} /> : <Pin size={13} />}
                          {pinned ? t("sessionsUnpin") : t("sessionsPin")}
                        </button>
                        <button
                          type="button"
                          title={
                            canReload
                              ? t("sessionsReloadTitle")
                              : active
                                ? t("sessionsReloadWait")
                                : t("sessionsReloadOnlyActive")
                          }
                          disabled={!canReload}
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => void reloadSessionFromDisk()}
                        >
                          <RefreshCw size={13} />
                          {t("sessionsReload")}
                        </button>
                        <div className="my-1 border-t border-border" />
                        <button
                          type="button"
                          title={
                            item.archived
                              ? t("sessionsRestoreTitle")
                              : canArchive
                                ? t("sessionsArchiveTitle")
                                : t("sessionsArchiveWait")
                          }
                          disabled={!item.archived && !canArchive}
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() =>
                            void runSessionFileAction(
                              item.archived ? "session.restore" : "session.archive",
                              item,
                            )
                          }
                        >
                          {item.archived ? (
                            <ArchiveRestore size={13} />
                          ) : (
                            <Archive size={13} />
                          )}
                          {item.archived ? t("sessionsRestore") : t("sessionsArchive")}
                        </button>
                        <button
                          type="button"
                          title={canDelete ? t("sessionsDeleteTitle") : t("sessionsDeleteWait")}
                          disabled={!canDelete}
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-danger hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={() => {
                            setMenuSessionId(null);
                            setConfirmAction({ kind: "delete", item });
                          }}
                        >
                          <Trash2 size={13} />
                          {t("commonDelete")}
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {workspace?.servicesReady && allItems.length > 0 && visibleItems.length === 0 && (
        <p className="px-2 py-3 text-center text-xs text-muted">{t("sessionsNoMatch")}</p>
      )}
      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-delete-title"
            className="w-full max-w-sm rounded-lg border border-border bg-surface-raised p-5 shadow-xl"
          >
            <h2 id="session-delete-title" className="text-base font-semibold">
              {confirmAction.kind === "delete"
                ? t("sessionsDeleteConfirmTitle")
                : t("sessionsCleanupConfirmTitle")}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {confirmAction.kind === "delete"
                ? t("sessionsDeleteConfirmBody", {
                    name: sessionDisplayName(confirmAction.item, t("sessionsUntitled")),
                  })
                : t("sessionsCleanupConfirmBody", { count: confirmAction.count })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                autoFocus
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-overlay"
                onClick={() => setConfirmAction(null)}
                disabled={sessionMutationBlocked}
              >
                {t("commonCancel")}
              </button>
              <button
                type="button"
                className="rounded-md bg-danger px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
                onClick={() => {
                  if (confirmAction.kind === "delete") {
                    void deleteSessionPermanently(confirmAction.item);
                  } else {
                    void cleanupArchivedSessions();
                  }
                }}
                disabled={sessionMutationBlocked}
              >
                {t("sessionsDeletePermanently")}
              </button>
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}
