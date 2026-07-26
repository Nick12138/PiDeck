import type { HostResponseEnvelope, SessionUsageReport } from "@pideck/protocol";
import { Archive, RefreshCw } from "lucide-react";
import { SectionHeader } from "../../components/SectionHeader";
import { useEffect, useState } from "react";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { formatTokenCount } from "../../lib/format-token-count";
import { requestUsageReportWithRetry } from "./usage-report-request";

type UsageReportResponse = HostResponseEnvelope<"session.usageReport">;

let usageReportInFlight: {
  key: string;
  promise: Promise<UsageReportResponse>;
} | null = null;

function sharedUsageReportRequest(
  key: string,
  request: () => Promise<UsageReportResponse>,
): Promise<UsageReportResponse> {
  if (usageReportInFlight?.key === key) return usageReportInFlight.promise;
  const promise = requestUsageReportWithRetry(request);
  usageReportInFlight = { key, promise };
  const clear = () => {
    if (usageReportInFlight?.promise === promise) usageReportInFlight = null;
  };
  void promise.then(clear, clear);
  return promise;
}

function formatCost(cost: number): string {
  if (cost <= 0) return "--";
  if (cost < 0.0001) return "<$0.0001";
  return `$${cost.toFixed(4)}`;
}

function useSessionUsageReport() {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const [report, setReport] = useState<SessionUsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!host || !workspace) {
      setReport(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const expectedHostId = host.hostInstanceId;
    const expectedWorkspaceId = workspace.id;
    const requestKey = `${expectedHostId}:${expectedWorkspaceId}:${workspace.revision}:${refreshKey}`;
    setLoading(true);
    setError(null);

    void sharedUsageReportRequest(requestKey, () =>
      hostClient.request(
        "session.usageReport",
        workspaceContext(host, workspace),
        null,
        120_000,
      ),
    )
      .then((response) => {
        const current = useAppStore.getState();
        if (
          cancelled ||
          current.host?.hostInstanceId !== expectedHostId ||
          current.workspace?.id !== expectedWorkspaceId
        ) {
          return;
        }
        if (!response.ok) {
          setError(response.error.message);
          return;
        }
        setReport(response.result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [host?.hostInstanceId, workspace?.id, workspace?.revision, refreshKey]);

  return {
    report,
    error,
    loading,
    refresh: () => setRefreshKey((value) => value + 1),
  };
}

export function UsageSettings() {
  const { report, error, loading, refresh } = useSessionUsageReport();
  const usage = report?.totals.usage;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SectionHeader title="Usage" subtitle="Token and cost totals for this workspace">
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-default disabled:opacity-50"
          title="Refresh usage report"
          aria-label="Refresh usage report"
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      </SectionHeader>

      <div className="grid shrink-0 grid-cols-3 border-b border-border">
        <div className="border-r border-border px-6 py-4">
          <p className="text-[11px] text-muted">Total tokens</p>
          <p className="mt-1 text-base font-semibold tabular-nums">
            {usage ? formatTokenCount(usage.totalTokens) : "--"}
          </p>
          {usage && (
            <dl className="mt-2 grid max-w-52 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-muted">
              <dt>Input</dt>
              <dd className="text-right tabular-nums">{formatTokenCount(usage.input)}</dd>
              <dt>Output</dt>
              <dd className="text-right tabular-nums">{formatTokenCount(usage.output)}</dd>
              <dt>Cache read</dt>
              <dd className="text-right tabular-nums">{formatTokenCount(usage.cacheRead)}</dd>
              <dt>Cache write</dt>
              <dd className="text-right tabular-nums">{formatTokenCount(usage.cacheWrite)}</dd>
              <dt>Reasoning</dt>
              <dd className="text-right tabular-nums">
                {usage.reasoning === undefined ? "—" : formatTokenCount(usage.reasoning)}
              </dd>
            </dl>
          )}
        </div>
        <div className="border-r border-border px-6 py-4">
          <p className="text-[11px] text-muted">Total cost</p>
          <p className="mt-1 text-base font-semibold tabular-nums">
            {usage ? formatCost(usage.cost.total) : "--"}
          </p>
        </div>
        <div className="px-6 py-4">
          <p className="text-[11px] text-muted">Sessions</p>
          <p className="mt-1 text-base font-semibold tabular-nums">
            {report ? report.totals.sessionCount.toLocaleString() : "--"}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="m-6 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : !report && loading ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted">
            Loading usage...
          </div>
        ) : report?.sessions.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted">
            No session usage found.
          </div>
        ) : (
          <table className="w-full table-fixed border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-surface-raised text-[11px] text-muted">
              <tr className="border-b border-border">
                <th scope="col" className="w-[42%] px-6 py-2.5 font-medium">Session</th>
                <th scope="col" className="w-[24%] px-3 py-2.5 font-medium">Updated</th>
                <th scope="col" className="w-[18%] px-3 py-2.5 text-right font-medium">Tokens</th>
                <th scope="col" className="w-[16%] px-6 py-2.5 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {report?.sessions.map((session) => (
                <tr key={session.sessionPath} className="border-b border-border/70">
                  <td className="px-6 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {session.archived && (
                        <>
                          <Archive size={13} className="shrink-0 text-muted" aria-hidden />
                          <span className="sr-only">Archived</span>
                        </>
                      )}
                      <span className="truncate font-medium" title={session.sessionPath}>
                        {session.name ?? "Untitled session"}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[10px] text-muted">
                      {session.messageCount.toLocaleString()} messages
                    </p>
                  </td>
                  <td className="px-3 py-3 text-muted">
                    {new Date(session.updatedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatTokenCount(session.usage.totalTokens)}
                  </td>
                  <td className="px-6 py-3 text-right tabular-nums text-muted">
                    {formatCost(session.usage.cost.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
