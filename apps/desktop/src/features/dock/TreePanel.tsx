import { useEffect, useState } from "react";
import {
  Bot,
  CircleDot,
  GitBranch,
  GitFork,
  LoaderCircle,
  RefreshCw,
  UserRound,
} from "lucide-react";
import type { SerializableSessionTreeNode } from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { requestFork } from "../../lib/fork-actions";
import { flattenSessionTree, type TreeRowKind } from "./tree-model";

const KIND_ICON: Record<TreeRowKind, typeof UserRound> = {
  user: UserRound,
  assistant: Bot,
  other: CircleDot,
};

export function TreePanel({ visible }: { visible: boolean }) {
  const session = useAppStore((state) => state.session);
  const applySessionSnapshot = useAppStore((state) => state.applySessionSnapshot);
  const setSessionDraft = useAppStore((state) => state.setSessionDraft);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [nodes, setNodes] = useState<SerializableSessionTreeNode[] | null>(null);
  const [leafId, setLeafId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);

  const hostInstanceId = useAppStore((state) => state.host?.hostInstanceId);
  const workspaceId = useAppStore((state) => state.workspace?.id);
  const workspaceRevision = useAppStore((state) => state.workspace?.revision);
  const sessionId = session?.sessionId;
  const sessionRevision = session?.revision;
  const busy = session ? !session.isIdle : true;
  const messageCount = session?.messages.length ?? 0;

  useEffect(() => {
    if (!visible) return;
    const current = useAppStore.getState();
    if (!current.host || !current.workspace || !current.session) {
      setNodes(null);
      setLeafId(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setError(null);
    const generation = captureRequestGeneration(current.host);
    void hostClient
      .request(
        "session.getTree",
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
          setError(res.error?.message ?? "Could not load the session tree");
          return;
        }
        setNodes(res.result.tree);
        setLeafId(res.result.leafId);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load the session tree");
      });
    return () => {
      cancelled = true;
    };
  }, [
    visible,
    hostInstanceId,
    workspaceId,
    workspaceRevision,
    sessionId,
    sessionRevision,
    messageCount,
    busy,
    refreshSeq,
  ]);

  // The tree belongs to the active session; drop it when the session changes.
  useEffect(() => {
    setNodes(null);
    setLeafId(null);
    setNavigating(null);
    setForking(null);
  }, [sessionId]);

  async function navigate(targetId: string) {
    const current = useAppStore.getState();
    if (!current.host || !current.workspace || !current.session) return;
    if (!current.session.isIdle || navigating) return;
    setNavigating(targetId);
    const generation = captureRequestGeneration(current.host);
    try {
      const res = await hostClient.request(
        "agent.navigateTree",
        activeSessionContext(current.host, current.workspace, current.session),
        { targetId },
      );
      if (
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(res.error?.message ?? "Could not switch branch", "error");
        return;
      }
      if (res.result.cancelled) {
        pushNotification("Branch switch was cancelled", "info");
        return;
      }
      applySessionSnapshot(res.result.session);
      if (res.result.editorText !== undefined) {
        setSessionDraft(res.result.session.sessionId, res.result.editorText);
      }
      setRefreshSeq((seq) => seq + 1);
    } catch (err) {
      pushNotification(
        err instanceof Error ? err.message : "Could not switch branch",
        "error",
      );
    } finally {
      setNavigating(null);
    }
  }

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted">
        No active session.
      </div>
    );
  }

  const rows = nodes ? flattenSessionTree(nodes, leafId) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <GitBranch size={13} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {busy
            ? "Agent is busy — navigation disabled"
            : "Click an entry to switch the session to that point"}
        </span>
        <button
          type="button"
          title="Refresh tree"
          aria-label="Refresh tree"
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
          onClick={() => setRefreshSeq((seq) => seq + 1)}
        >
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {error ? (
          <p className="px-3 py-2 text-xs text-danger">{error}</p>
        ) : nodes === null ? (
          <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
            <LoaderCircle size={12} className="animate-spin" /> Loading session tree…
          </p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted">No entries yet.</p>
        ) : (
          rows.map((row) => {
            const Icon = KIND_ICON[row.kind];
            const actionLocked = busy || navigating !== null || forking !== null;
            return (
              <div
                key={row.id}
                className={`group flex items-stretch ${
                  row.isLeaf ? "bg-surface-overlay/60" : "hover:bg-surface-overlay/40"
                }`}
              >
                <button
                  type="button"
                  disabled={actionLocked || row.isLeaf}
                  aria-current={row.isLeaf ? "true" : undefined}
                  title={row.excerpt}
                  className={`flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs ${
                    row.onPath ? "text-foreground" : "text-muted"
                  } disabled:cursor-default`}
                  style={{ paddingLeft: `${12 + row.depth * 16}px` }}
                  onClick={() => void navigate(row.id)}
                >
                  {navigating === row.id || forking === row.id ? (
                    <LoaderCircle size={12} className="shrink-0 animate-spin" />
                  ) : (
                    <Icon
                      size={12}
                      className={`shrink-0 ${row.onPath ? "text-accent" : ""}`}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{row.excerpt}</span>
                  {row.label && (
                    <span className="shrink-0 rounded bg-surface-overlay px-1.5 py-0.5 text-[10px] text-muted">
                      {row.label}
                    </span>
                  )}
                  {row.isLeaf && (
                    <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                      current
                    </span>
                  )}
                </button>
                {row.kind === "user" && (
                  <button
                    type="button"
                    disabled={actionLocked}
                    title="Fork from here"
                    aria-label={`Fork from: ${row.excerpt}`}
                    className="hidden shrink-0 items-center justify-center px-2 text-muted hover:text-foreground disabled:opacity-40 group-hover:flex"
                    onClick={() => {
                      setForking(row.id);
                      void requestFork(row.id).finally(() => setForking(null));
                    }}
                  >
                    <GitFork size={12} />
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
