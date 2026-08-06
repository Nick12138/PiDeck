import type { HostResponseEnvelope, SessionUsageReport } from "@pideck/protocol";
import { Archive, RefreshCw } from "lucide-react";
import { SectionHeader } from "../../components/SectionHeader";
import { useT } from "../../lib/i18n/use-t";
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
  const hostInstanceId = host?.hostInstanceId;
  const workspaceId = workspace?.id;
  const workspaceRevision = workspace?.revision;

  useEffect(() => {
    if (!hostInstanceId || !workspaceId || workspaceRevision === undefined) {
      setReport(null);
      setError(null);
      setLoading(false);
      return;
    }
    const current = useAppStore.getState();
    const requestHost = current.host;
    const requestWorkspace = current.workspace;
    if (
      !requestHost ||
      !requestWorkspace ||
      requestHost.hostInstanceId !== hostInstanceId ||
      requestWorkspace.id !== workspaceId ||
      requestWorkspace.revision !== workspaceRevision
    ) {
      return;
    }
    let cancelled = false;
    const expectedHostId = requestHost.hostInstanceId;
    const expectedWorkspaceId = requestWorkspace.id;
    const requestKey = `${expectedHostId}:${expectedWorkspaceId}:${requestWorkspace.revision}:${refreshKey}`;
    setLoading(true);
    setError(null);

    void sharedUsageReportRequest(requestKey, () =>
      hostClient.request(
        "session.usageReport",
        workspaceContext(requestHost, requestWorkspace),
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
  }, [hostInstanceId, workspaceId, workspaceRevision, refreshKey]);

  return {
    report,
    error,
    loading,
    refresh: () => setRefreshKey((value) => value + 1),
  };
}

export function UsageSettings() {
  const t = useT();
  const { report, error, loading, refresh } = useSessionUsageReport();
  const usage = report?.totals.usage;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SectionHeader title={t("navUsage")} subtitle={t("usageSubtitle")}>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-default disabled:opacity-50"
          title={t("usageRefresh")}
          aria-label={t("usageRefresh")}
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      </SectionHeader>

      <div className="grid shrink-0 grid-cols-3 border-b border-border">
        <div className="border-r border-border px-6 py-4">
          <p className="text-[11px] text-muted">{t("usageTotalTokens")}</p>
          <p className="mt-1 text-base font-semibold tabular-nums">
            {usage ? formatTokenCount(usage.totalTokens) : "--"}
          </p>
          {usage && (
            <dl className="mt-2 grid max-w-52 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-muted">
              <dt>{t("usageInput")}</dt>
              <dd className="text-right tabular-nums">{formatTokenCount(usage.input)}</dd>
              <dt>{t("usageOutput")}</dt>
              <dd className="text-right tabular-nums">{formatTokenCount(usage.output)}</dd>
              <dt>{t("usageCacheRead")}</dt>
              <dd className="text-right tabular-nums">{formatTokenCount(usage.cacheRead)}</dd>
              <dt>{t("usageCacheWrite")}</dt>
              <dd className="text-right tabular-nums">{formatTokenCount(usage.cacheWrite)}</dd>
              <dt>{t("usageReasoning")}</dt>
              <dd className="text-right tabular-nums">
                {usage.reasoning === undefined ? "—" : formatTokenCount(usage.reasoning)}
              </dd>
            </dl>
          )}
        </div>
        <div className="border-r border-border px-6 py-4">
          <p className="text-[11px] text-muted">{t("usageTotalCost")}</p>
          <p className="mt-1 text-base font-semibold tabular-nums">
            {usage ? formatCost(usage.cost.total) : "--"}
          </p>
        </div>
        <div className="px-6 py-4">
          <p className="text-[11px] text-muted">{t("usageSessions")}</p>
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
            {t("usageLoading")}
          </div>
        ) : report?.sessions.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted">
            {t("usageEmpty")}
          </div>
        ) : (
          <table className="w-full table-fixed border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-surface-raised text-[11px] text-muted">
              <tr className="interface-density-table-header-row border-b border-border">
                <th scope="col" className="w-[42%] px-6 py-2.5 font-medium">
                  {t("usageColSession")}
                </th>
                <th scope="col" className="w-[24%] px-3 py-2.5 font-medium">
                  {t("usageColUpdated")}
                </th>
                <th scope="col" className="w-[18%] px-3 py-2.5 text-right font-medium">
                  {t("usageColTokens")}
                </th>
                <th scope="col" className="w-[16%] px-6 py-2.5 text-right font-medium">
                  {t("usageColCost")}
                </th>
              </tr>
            </thead>
            <tbody>
              {report?.sessions.map((session) => (
                <tr
                  key={session.sessionPath}
                  className="interface-density-table-row border-b border-border/70"
                >
                  <td className="px-6 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {session.archived && (
                        <>
                          <Archive size={13} className="shrink-0 text-muted" aria-hidden />
                          <span className="sr-only">{t("usageArchived")}</span>
                        </>
                      )}
                      <span className="truncate font-medium" title={session.sessionPath}>
                        {session.name ?? t("usageUntitledSession")}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[10px] text-muted">
                      {t("usageMessages", { count: session.messageCount.toLocaleString() })}
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
