import type { SessionSnapshot, SessionSummary } from "@pideck/protocol";
import type { SessionCatalogEntry, SessionRuntimeState } from "../../lib/stores/session-catalog";

export type SessionFilter = "active" | "archived";

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

/** Callers must pass the localized untitled label so search/render match the UI locale. */
export function sessionDisplayName(item: Pick<SessionSummary, "name">, fallback: string): string {
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
  untitledLabel: string,
): SessionCatalogEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filter === "archived" ? !item.archived : item.archived) return false;
    if (!normalizedQuery) return true;
    return [sessionDisplayName(item, untitledLabel), item.cwd, item.sessionId]
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
function isSessionRuntimeBusy(state: SessionRuntimeState): boolean {
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

export function shouldRetrySessionRpc(error: { code?: string; retryable?: boolean }): boolean {
  return error.code === "SERVICE_GRAPH_BUSY" && error.retryable === true;
}

/** Short-lived sdk.read locks make SERVICE_GRAPH_BUSY transient; retry briefly. */
export async function requestSessionRpcWithRetry<
  T extends { ok: true } | { ok: false; error: { code?: string; retryable?: boolean } },
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
