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
  filter: SessionFilter,
): SessionCatalogEntry[] {
  return items.filter((item) => (filter === "archived" ? item.archived : !item.archived));
}

export type SessionTimeGroup = "today" | "thisWeek" | "earlier";

/** Millisecond start-of-day boundary. */
function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Millisecond start-of-week boundary (Monday 00:00). */
function startOfWeek(now: number): number {
  const d = new Date(startOfDay(now));
  const day = d.getDay();
  const mondayOffset = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - mondayOffset);
  return d.getTime();
}

export function sessionTimeGroup(updatedAt: number, now: number = Date.now()): SessionTimeGroup {
  if (updatedAt >= startOfDay(now)) return "today";
  if (updatedAt >= startOfWeek(now)) return "thisWeek";
  return "earlier";
}

/** Split already-sorted (newest first) items into time buckets. */
export function groupSessionItemsByTime(
  items: SessionCatalogEntry[],
  now: number = Date.now(),
): { group: SessionTimeGroup; items: SessionCatalogEntry[] }[] {
  const buckets: Record<SessionTimeGroup, SessionCatalogEntry[]> = {
    today: [],
    thisWeek: [],
    earlier: [],
  };
  for (const item of items) {
    buckets[sessionTimeGroup(item.updatedAt, now)].push(item);
  }
  return (["today", "thisWeek", "earlier"] as SessionTimeGroup[]).map((group) => ({
    group,
    items: buckets[group],
  }));
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

export function removedArchivedSessionIds(
  before: readonly Pick<SessionCatalogEntry, "sessionId" | "archived">[],
  after: readonly Pick<SessionCatalogEntry, "sessionId" | "archived">[],
): string[] {
  const remaining = new Set(after.map((item) => item.sessionId));
  return before
    .filter((item) => item.archived && !remaining.has(item.sessionId))
    .map((item) => item.sessionId);
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
