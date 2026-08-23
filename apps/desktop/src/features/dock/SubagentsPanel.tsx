import { ChevronRight, CircleAlert, LoaderCircle, Users } from "lucide-react";
import type { SubagentStatusNode, SubagentsStatusSnapshot } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";

function stateLabel(state: SubagentStatusNode["state"], t: ReturnType<typeof useT>): string {
  switch (state) {
    case "running":
      return t("subagentsStateRunning");
    case "queued":
      return t("subagentsStateQueued");
    case "complete":
      return t("subagentsStateComplete");
    case "failed":
      return t("subagentsStateFailed");
    case "paused":
      return t("subagentsStatePaused");
    case "stopped":
      return t("subagentsStateStopped");
    default:
      return t("subagentsStateRejected");
  }
}

function stateClass(state: SubagentStatusNode["state"]): string {
  if (state === "running") return "text-accent";
  if (state === "complete") return "text-success";
  if (state === "failed" || state === "rejected") return "text-danger";
  if (state === "paused" || state === "stopped") return "text-warning";
  return "text-muted";
}

function NodeRow({ node, depth = 0 }: { node: SubagentStatusNode; depth?: number }) {
  const t = useT();
  const hasChildren = Boolean(node.children?.length);
  const activity = node.activity;
  const label = stateLabel(node.state, t);
  return (
    <details
      open={node.state === "running" || depth === 0}
      className="group"
      data-subagent-node={node.id}
    >
      <summary
        className="flex min-w-0 cursor-pointer list-none items-start gap-2 rounded px-2 py-2 text-xs hover:bg-surface-overlay [&::-webkit-details-marker]:hidden"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {hasChildren ? (
          <ChevronRight
            size={13}
            className="mt-0.5 shrink-0 transition-transform group-open:rotate-90"
          />
        ) : (
          <span className="w-[13px] shrink-0" />
        )}
        <span className={`mt-0.5 shrink-0 ${stateClass(node.state)}`} aria-hidden="true">
          {node.state === "running" ? <LoaderCircle size={13} className="animate-spin" /> : "●"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate font-medium text-foreground">{node.label}</span>
            <span className={`shrink-0 text-[10px] ${stateClass(node.state)}`}>{label}</span>
          </span>
          {activity?.currentTool && (
            <span className="mt-0.5 block truncate text-[10px] text-muted">
              {activity.currentTool}
            </span>
          )}
        </span>
      </summary>
      {hasChildren && (
        <div className="border-l border-border/70" style={{ marginLeft: `${14 + depth * 14}px` }}>
          {node.children!.map((child) => (
            <NodeRow key={`${node.id}:${child.id}`} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </details>
  );
}

function FleetSummary({ status }: { status: SubagentsStatusSnapshot }) {
  const t = useT();
  if (status.fleet.length === 0) return null;
  return (
    <div className="border-b border-border px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
        <Users size={12} />
        {t("subagentsActiveChildren")}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {status.fleet.map((entry) => (
          <span
            key={entry.key}
            className="rounded-full border border-border bg-surface-overlay px-2 py-0.5 text-[10px] text-foreground"
            title={entry.goal}
          >
            {entry.role || entry.agent}
          </span>
        ))}
      </div>
    </div>
  );
}

export function SubagentsPanel() {
  const t = useT();
  const status = useAppStore((state) => state.subagentsStatus);
  const hasRuns = status.runs.length > 0;
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={t("dockSubagents")}
      data-subagents-panel
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Users size={14} className="shrink-0 text-accent" />
          <span className="truncate text-xs font-semibold">{t("subagentsTitle")}</span>
          {status.totalActive > 0 && (
            <span className="text-[10px] text-accent">{status.totalActive}</span>
          )}
        </div>
        <span className={`text-[10px] ${status.available ? "text-success" : "text-muted"}`}>
          {status.available ? t("subagentsConnected") : t("subagentsUnavailable")}
        </span>
      </div>
      <FleetSummary status={status} />
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {!status.available ? (
          <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted">
            <CircleAlert size={18} />
            <p>{t("subagentsUnavailableBody")}</p>
          </div>
        ) : !hasRuns ? (
          <div className="flex h-full min-h-32 items-center justify-center px-6 text-center text-xs text-muted">
            {t("subagentsEmpty")}
          </div>
        ) : (
          status.runs.map((node) => <NodeRow key={node.id} node={node} />)
        )}
      </div>
      {status.omitted > 0 && (
        <div className="shrink-0 border-t border-border px-3 py-1.5 text-[10px] text-muted">
          {t("subagentsOmitted", { count: status.omitted })}
        </div>
      )}
    </section>
  );
}
