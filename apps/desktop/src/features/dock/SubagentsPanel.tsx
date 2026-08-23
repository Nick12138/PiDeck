import { useEffect, useMemo, useState } from "react";
import { CircleAlert, LoaderCircle, Square, Users } from "lucide-react";
import type {
  SubagentSessionSnapshot,
  SubagentStatusNode,
  SubagentsStatusSnapshot,
} from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { buildTranscriptRows, type TranscriptRow } from "../chat/transcript-model";
import { TranscriptRowView } from "../chat/Transcript";

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

function roleLabel(role: string | undefined, t: ReturnType<typeof useT>): string | undefined {
  switch (role?.trim().toLowerCase()) {
    case "scout":
      return t("subagentsRoleScout");
    case "researcher":
      return t("subagentsRoleResearcher");
    case "worker":
      return t("subagentsRoleWorker");
    case "reviewer":
      return t("subagentsRoleReviewer");
    case "delegate":
      return t("subagentsRoleDelegate");
    case "oracle":
    case "advisor":
      return t("subagentsRoleAdvisor");
    default:
      return role?.trim() || undefined;
  }
}

function flattenNodes(
  nodes: SubagentStatusNode[],
  depth = 0,
): Array<{ node: SubagentStatusNode; depth: number }> {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.children ? flattenNodes(node.children, depth + 1) : []),
  ]);
}

function TranscriptView({ snapshot }: { snapshot: SubagentSessionSnapshot }) {
  const t = useT();
  const [expandedUserRows, setExpandedUserRows] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(
    () =>
      buildTranscriptRows([], {
        entries: snapshot.entries,
        turnActive: snapshot.state === "running",
      }),
    [snapshot.entries, snapshot.state],
  );
  const firstUserRowKey = useMemo(() => rows.find((row) => row.role === "user")?.key, [rows]);

  useEffect(() => {
    setExpandedUserRows((current) => {
      if (!firstUserRowKey) return current.size === 0 ? current : new Set();
      if (current.size === 0 || (current.size === 1 && current.has(firstUserRowKey))) {
        return current;
      }
      return current.has(firstUserRowKey) ? new Set([firstUserRowKey]) : new Set();
    });
  }, [firstUserRowKey]);

  return (
    <div className="border-t border-border bg-surface/60">
      {snapshot.truncated && (
        <div className="mx-3 mt-3 rounded border border-border bg-surface-overlay px-2 py-1.5 text-[10px] text-muted">
          {t("subagentsConversationTruncated")}
        </div>
      )}
      <div className="conversation-content-width mx-auto flex flex-col gap-5 px-3 py-4 sm:gap-6">
        {rows.length === 0 ? (
          <div className="flex min-h-20 items-center justify-center text-center text-xs text-muted">
            {t("subagentsNoConversation")}
          </div>
        ) : (
          rows.map((row: TranscriptRow) => {
            const isFirstUser = row.key === firstUserRowKey;
            return (
              <div className="transcript-row" data-row-key={row.key} key={row.key}>
                <TranscriptRowView
                  row={row}
                  mode="static"
                  showCaret={false}
                  working={false}
                  retryableTurn={undefined}
                  retryVisible={false}
                  goOnVisible={false}
                  onRetry={async () => undefined}
                  readOnly
                  userCollapsible={isFirstUser}
                  userExpanded={isFirstUser && expandedUserRows.has(row.key)}
                  onToggleUser={
                    isFirstUser
                      ? () =>
                          setExpandedUserRows((current) =>
                            current.has(row.key) ? new Set() : new Set([row.key]),
                          )
                      : undefined
                  }
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function InlineNode({
  node,
  depth,
  expanded,
  snapshot,
  loading,
  loadError,
  stopping,
  onToggle,
  onStop,
}: {
  node: SubagentStatusNode;
  depth: number;
  expanded: boolean;
  snapshot: SubagentSessionSnapshot | null;
  loading: boolean;
  loadError: boolean;
  stopping: boolean;
  onToggle: () => void;
  onStop: () => void;
}) {
  const t = useT();
  const displayName = node.name ?? node.label;
  const role = node.role?.trim();
  const localizedRole = roleLabel(role, t);
  const showRole = Boolean(localizedRole && role !== displayName);
  return (
    <div className="group" data-subagent-node={node.id}>
      <div
        className={`flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-overlay ${expanded ? "bg-surface-overlay" : ""}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
          aria-label={displayName}
          onClick={onToggle}
          title={node.label !== displayName ? node.label : undefined}
        >
          {showRole && (
            <span
              className="max-w-24 shrink-0 truncate rounded border border-border px-1 py-0.5 text-[9px] text-muted"
              title={t("subagentsRole", { role: localizedRole ?? "" })}
              aria-label={t("subagentsRole", { role: localizedRole ?? "" })}
            >
              {localizedRole}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{displayName}</span>
          {node.activity?.currentTool && (
            <span className="max-w-24 truncate text-[10px] text-muted">
              {node.activity.currentTool}
            </span>
          )}
          <span
            className={`shrink-0 ${stateClass(node.state)}`}
            aria-label={stateLabel(node.state, t)}
            title={stateLabel(node.state, t)}
          >
            {node.state === "running" ? (
              <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <span className="text-[10px]">{stateLabel(node.state, t)}</span>
            )}
          </span>
        </button>
        {node.state === "running" && (
          <button
            type="button"
            className="flex size-6 shrink-0 items-center justify-center rounded text-warning opacity-0 transition-opacity hover:bg-warning/15 hover:text-warning group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait disabled:opacity-60"
            title={t("subagentsStop")}
            aria-label={t("subagentsStop")}
            disabled={stopping}
            onClick={(event) => {
              event.stopPropagation();
              onStop();
            }}
          >
            <Square size={12} fill="currentColor" />
          </button>
        )}
      </div>
      <div
        className={`grid overflow-hidden transition-[grid-template-rows] duration-150 ease-out ${expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
        aria-hidden={!expanded}
      >
        <div className="min-h-0 overflow-hidden" style={{ marginLeft: `${depth * 14}px` }}>
          {snapshot ? (
            <TranscriptView snapshot={snapshot} />
          ) : (
            <div className="border-t border-border px-6 py-4 text-xs text-muted">
              {loading || loadError
                ? t("subagentsLoadingConversation")
                : t("subagentsLoadingConversation")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function SubagentsPanel() {
  const t = useT();
  const status = useAppStore((state) => state.subagentsStatus);
  const host = useAppStore((state) => state.host);
  const workspace = useAppStore((state) => state.workspace);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, SubagentSessionSnapshot>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const hasRuns = status.runs.length > 0;
  const activeCount = useMemo(
    () => flattenNodes(status.runs).filter(({ node }) => node.state === "running").length,
    [status.runs],
  );
  const nodes = useMemo(() => flattenNodes(status.runs), [status.runs]);

  useEffect(() => {
    if (expandedId && !nodes.some(({ node }) => node.id === expandedId)) {
      setExpandedId(null);
    }
  }, [expandedId, nodes]);

  useEffect(() => {
    if (!expandedId || !host || !workspace) return;
    const target = nodes.find(({ node }) => node.id === expandedId)?.node;
    if (!target) return;
    let cancelled = false;
    const load = async () => {
      setLoadingId(target.id);
      try {
        const response = await hostClient.request(
          "subagents.getSession",
          workspaceContext(host, workspace),
          { nodeId: target.id },
          15_000,
        );
        if (cancelled) return;
        if (response.ok) {
          setSnapshots((current) => ({ ...current, [target.id]: response.result }));
        }
      } finally {
        if (!cancelled) setLoadingId(null);
      }
    };
    void load();
    const interval =
      target.state === "running" ? window.setInterval(() => void load(), 1_500) : undefined;
    return () => {
      cancelled = true;
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [expandedId, host, nodes, workspace]);

  const stopNode = async (node: SubagentStatusNode) => {
    if (!host || !workspace || node.state !== "running") return;
    setStoppingId(node.id);
    try {
      await hostClient.request(
        "subagents.stop",
        workspaceContext(host, workspace),
        { nodeId: node.id },
        15_000,
      );
    } finally {
      setStoppingId(null);
    }
  };

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
        </div>
        <span className="text-[10px] text-accent">
          {t("subagentsActiveCount", { count: activeCount })}
        </span>
      </div>
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
        <div className="min-h-0 flex-1 overflow-auto border-b border-border p-1.5">
          {nodes.map(({ node, depth }) => (
            <InlineNode
              key={node.id}
              node={node}
              depth={depth}
              expanded={expandedId === node.id}
              snapshot={snapshots[node.id] ?? null}
              loading={loadingId === node.id}
              loadError={false}
              stopping={stoppingId === node.id}
              onToggle={() => setExpandedId((current) => (current === node.id ? null : node.id))}
              onStop={() => void stopNode(node)}
            />
          ))}
        </div>
      )}
      {status.omitted > 0 && (
        <div className="shrink-0 border-t border-border px-3 py-1.5 text-[10px] text-muted">
          {t("subagentsOmitted", { count: status.omitted })}
        </div>
      )}
    </section>
  );
}
