import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { SessionStatsSnapshot } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { formatTokenCount } from "../../lib/format-token-count";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </>
  );
}

export function SessionStatsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const [stats, setStats] = useState<SessionStatsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hostInstanceId = host?.hostInstanceId;
  const workspaceId = workspace?.id;
  const workspaceRevision = workspace?.revision;
  const sessionId = session?.sessionId;
  const sessionRevision = session?.revision;

  useEffect(() => {
    if (!open) return;
    const current = useAppStore.getState();
    if (!current.host || !current.workspace || !current.session) return;
    let cancelled = false;
    setStats(null);
    setError(null);
    const generation = captureRequestGeneration(current.host);
    void hostClient
      .request(
        "session.getStats",
        activeSessionContext(current.host, current.workspace, current.session),
        null,
      )
      .then((res) => {
        if (cancelled) return;
        if (
          !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
            session: true,
          })
        ) {
          return;
        }
        if (!res.ok) {
          setError(res.error?.message ?? "Could not load session stats");
          return;
        }
        setStats(res.result);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load session stats");
      });
    return () => {
      cancelled = true;
    };
  }, [open, hostInstanceId, workspaceId, workspaceRevision, sessionId, sessionRevision]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  const tokens = stats?.tokens;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-stats-title"
        className="w-full max-w-md rounded-lg border border-border bg-surface-raised p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="session-stats-title" className="truncate text-base font-semibold">
              {session?.name?.trim() || "Session stats"}
            </h2>
            {sessionId && (
              <p className="truncate text-[11px] text-muted" title={sessionId}>
                {sessionId}
              </p>
            )}
          </div>
          <button
            type="button"
            title="Close"
            aria-label="Close"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : !stats ? (
          <p className="text-sm text-muted">Loading session stats…</p>
        ) : (
          <div className="flex flex-col text-xs leading-5">
            <span className="mb-1 text-[10px] font-medium uppercase text-muted">
              Messages
            </span>
            <div className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5">
              <StatRow label="Total" value={String(stats.messageCount)} />
              {stats.userMessageCount !== undefined && (
                <StatRow label="User" value={String(stats.userMessageCount)} />
              )}
              {stats.assistantMessageCount !== undefined && (
                <StatRow label="Assistant" value={String(stats.assistantMessageCount)} />
              )}
              {stats.toolCallCount !== undefined && (
                <StatRow label="Tool calls" value={String(stats.toolCallCount)} />
              )}
              {stats.toolResultCount !== undefined && (
                <StatRow label="Tool results" value={String(stats.toolResultCount)} />
              )}
            </div>
            {tokens && (
              <>
                <span className="mb-1 mt-3 text-[10px] font-medium uppercase text-muted">
                  Tokens
                </span>
                <div className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5">
                  <StatRow label="Input" value={formatTokenCount(tokens.input)} />
                  <StatRow label="Output" value={formatTokenCount(tokens.output)} />
                  <StatRow label="Cache read" value={formatTokenCount(tokens.cacheRead)} />
                  <StatRow label="Cache write" value={formatTokenCount(tokens.cacheWrite)} />
                  <StatRow label="Total" value={formatTokenCount(tokens.total)} />
                </div>
              </>
            )}
            {stats.cost !== undefined && (
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-x-6">
                <span className="text-[10px] font-medium uppercase text-muted">Cost</span>
                <span className="tabular-nums">{usd.format(stats.cost)}</span>
              </div>
            )}
            {stats.sessionFile && (
              <p className="mt-3 truncate text-[11px] text-muted" title={stats.sessionFile}>
                {stats.sessionFile}
              </p>
            )}
            <p className="mt-3 text-[10px] text-muted">
              Aggregated over the full session history, including compacted entries.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
