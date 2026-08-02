import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  GitChangeKind,
  GitDiffSnapshot,
  GitFileChange,
  GitStatusSnapshot,
  HostError,
} from "@pideck/protocol";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  FileCode2,
  GitCommitHorizontal,
  GitCompareArrows,
  LoaderCircle,
  Plus,
  RefreshCw,
  Undo2,
} from "lucide-react";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { useT, type Translate } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";

type ReadyStatus = Extract<GitStatusSnapshot, { state: "ready" }>;
type DiffSelection = { path: string; area: "staged" | "unstaged" };
type ListRow =
  | { kind: "header"; area: "staged" | "unstaged"; count: number }
  | { kind: "file"; area: "staged" | "unstaged"; file: GitFileChange };

type DiffLine = {
  content: string;
  kind: "addition" | "deletion" | "hunk" | "meta" | "context";
  oldLine: number | null;
  newLine: number | null;
};

function splitPath(path: string): { name: string; directory: string } {
  const index = path.lastIndexOf("/");
  return index < 0
    ? { name: path, directory: "" }
    : { name: path.slice(index + 1), directory: path.slice(0, index) };
}

export function gitChangeLetter(change: GitChangeKind): string {
  switch (change) {
    case "added": return "A";
    case "modified": return "M";
    case "deleted": return "D";
    case "renamed": return "R";
    case "copied": return "C";
    case "type_changed": return "T";
    case "untracked": return "U";
    case "conflicted": return "!";
  }
}

function changeLabel(change: GitChangeKind, t: Translate): string {
  switch (change) {
    case "added": return t("gitChangeAdded");
    case "modified": return t("gitChangeModified");
    case "deleted": return t("gitChangeDeleted");
    case "renamed": return t("gitChangeRenamed");
    case "copied": return t("gitChangeCopied");
    case "type_changed": return t("gitChangeTypeChanged");
    case "untracked": return t("gitChangeUntracked");
    case "conflicted": return t("gitChangeConflicted");
  }
}

function errorMessage(error: HostError | undefined, fallback: string, t: Translate): string {
  if (!error) return fallback;
  switch (error.code) {
    case "GIT_UNAVAILABLE": return t("gitUnavailable");
    case "GIT_OUTPUT_LIMIT": return t("gitOutputTooLarge");
    case "STALE_REVISION": return t("gitStatusStale");
    case "SERVICE_GRAPH_BUSY": return t("gitBusy");
    default: return error.message || fallback;
  }
}

export function buildGitListRows(status: ReadyStatus): ListRow[] {
  const unstaged = status.files.filter((file) => file.unstaged !== null);
  const staged = status.files.filter((file) => file.staged !== null);
  const rows: ListRow[] = [];
  if (unstaged.length > 0) {
    rows.push({ kind: "header", area: "unstaged", count: unstaged.length });
    rows.push(...unstaged.map((file) => ({ kind: "file" as const, area: "unstaged" as const, file })));
  }
  if (staged.length > 0) {
    rows.push({ kind: "header", area: "staged", count: staged.length });
    rows.push(...staged.map((file) => ({ kind: "file" as const, area: "staged" as const, file })));
  }
  return rows;
}

export function parseUnifiedDiffLines(patch: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return patch.split("\n").map((content) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(content);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { content, kind: "hunk", oldLine: null, newLine: null };
    }
    if (!inHunk || content.startsWith("\\ No newline")) {
      return { content, kind: "meta", oldLine: null, newLine: null };
    }
    if (content.startsWith("+") && !content.startsWith("+++")) {
      const line = { content, kind: "addition" as const, oldLine: null, newLine };
      newLine += 1;
      return line;
    }
    if (content.startsWith("-") && !content.startsWith("---")) {
      const line = { content, kind: "deletion" as const, oldLine, newLine: null };
      oldLine += 1;
      return line;
    }
    const line = { content, kind: "context" as const, oldLine, newLine };
    oldLine += 1;
    newLine += 1;
    return line;
  });
}

function isSelectionPresent(status: ReadyStatus, selection: DiffSelection): boolean {
  const file = status.files.find((candidate) => candidate.path === selection.path);
  return Boolean(file && file[selection.area] !== null);
}

export function ChangesPanel({ visible }: { visible: boolean }) {
  const t = useT();
  const host = useAppStore((state) => state.host);
  const workspace = useAppStore((state) => state.workspace);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [snapshot, setSnapshot] = useState<GitStatusSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<DiffSelection | null>(null);
  const [diff, setDiff] = useState<GitDiffSnapshot | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const workspaceKey = host && workspace
    ? `${host.hostInstanceId}:${workspace.id}:${workspace.revision}`
    : "none";

  const acceptSnapshot = useCallback((next: GitStatusSnapshot) => {
    setSnapshot((current) => current && current.revision > next.revision ? current : next);
    setError(null);
  }, []);

  useEffect(() => {
    if (!selection || (snapshot?.state === "ready" && isSelectionPresent(snapshot, selection))) {
      return;
    }
    setSelection(null);
    setDiff(null);
  }, [selection, snapshot]);

  useEffect(() => {
    generation.current += 1;
    setSnapshot(null);
    setLoading(false);
    setError(null);
    setSelection(null);
    setDiff(null);
    setDiffLoading(false);
    setOperation(null);
    setCommitMessage("");
    setCommitSha(null);
  }, [workspaceKey]);

  const refresh = useCallback(async () => {
    if (!host || !workspace) return;
    const requestGeneration = generation.current;
    setLoading(true);
    try {
      const response = await hostClient.request(
        "git.getStatus",
        workspaceContext(host, workspace),
        null,
        12_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitLoadFailed"), t));
        return;
      }
      acceptSnapshot(response.result);
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitLoadFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [acceptSnapshot, host, t, workspace]);

  useEffect(() => {
    if (!visible || !host || !workspace) return;
    const requestGeneration = ++generation.current;
    const context = workspaceContext(host, workspace);
    setLoading(true);
    void hostClient
      .request("git.setWatching", context, { enabled: true }, 12_000)
      .then((response) => {
        if (requestGeneration !== generation.current) return;
        if (!response.ok) {
          setError(errorMessage(response.error, t("gitLoadFailed"), t));
          return;
        }
        if (response.result.snapshot) acceptSnapshot(response.result.snapshot);
      })
      .catch((requestError) => {
        if (requestGeneration === generation.current) {
          setError(requestError instanceof Error ? requestError.message : t("gitLoadFailed"));
        }
      })
      .finally(() => {
        if (requestGeneration === generation.current) setLoading(false);
      });
    return () => {
      generation.current += 1;
      void hostClient.request("git.setWatching", context, { enabled: false }, 12_000).catch(() => undefined);
    };
  }, [visible, workspaceKey, acceptSnapshot, host, t, workspace]);

  useEffect(
    () =>
      hostClient.onEvent((event) => {
        if (
          !visible ||
          event.event !== "git.changed" ||
          !host ||
          !workspace ||
          event.hostInstanceId !== host.hostInstanceId ||
          event.workspaceId !== workspace.id ||
          event.workspaceRevision !== workspace.revision
        ) return;
        acceptSnapshot(event.payload.snapshot);
      }),
    [acceptSnapshot, host, visible, workspace],
  );

  const ready = snapshot?.state === "ready" ? snapshot : null;
  const rows = useMemo(() => (ready ? buildGitListRows(ready) : []), [ready]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => rows[index]?.kind === "header" ? 30 : 36,
    getItemKey: (index) => {
      const row = rows[index];
      return row?.kind === "file" ? `${row.area}:${row.file.path}` : `header:${row?.area ?? index}`;
    },
    overscan: 12,
  });

  const loadDiff = async (next: DiffSelection) => {
    if (!host || !workspace || !ready) return;
    const requestGeneration = generation.current;
    setSelection(next);
    setDiff(null);
    setDiffLoading(true);
    setError(null);
    try {
      const response = await hostClient.request(
        "git.getDiff",
        workspaceContext(host, workspace),
        { ...next, expectedRevision: ready.revision },
        12_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitDiffFailed"), t));
        if (response.error?.code === "STALE_REVISION") void refresh();
        return;
      }
      setDiff(response.result);
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitDiffFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setDiffLoading(false);
    }
  };

  const mutate = async (file: GitFileChange, area: "staged" | "unstaged") => {
    if (!host || !workspace || !ready) return;
    const method = area === "unstaged" ? "git.stage" : "git.unstage";
    const key = `${method}:${file.path}`;
    const requestGeneration = generation.current;
    setOperation(key);
    setError(null);
    try {
      const response = await hostClient.request(
        method,
        workspaceContext(host, workspace),
        { path: file.path, expectedRevision: ready.revision },
        32_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitOperationFailed"), t));
        if (response.error?.code === "STALE_REVISION") void refresh();
        return;
      }
      if (response.result.snapshot) acceptSnapshot(response.result.snapshot);
      else void refresh();
      if (response.result.warning) pushNotification(response.result.warning, "warning");
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitOperationFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setOperation(null);
    }
  };

  const stagedCount = ready?.files.filter((file) => file.staged !== null).length ?? 0;
  const hasConflicts = ready?.files.some((file) => file.conflict) ?? false;
  const canCommit = Boolean(
    ready && stagedCount > 0 && !hasConflicts && commitMessage.trim() && !operation,
  );

  const commit = async () => {
    if (!host || !workspace || !ready || !canCommit) return;
    const requestGeneration = generation.current;
    setOperation("commit");
    setCommitSha(null);
    setError(null);
    try {
      const response = await hostClient.request(
        "git.commit",
        workspaceContext(host, workspace),
        { message: commitMessage.trim(), expectedIndexGeneration: ready.indexGeneration },
        65_000,
      );
      if (requestGeneration !== generation.current) return;
      if (!response.ok) {
        setError(errorMessage(response.error, t("gitCommitFailed"), t));
        if (response.error?.code === "STALE_REVISION") void refresh();
        return;
      }
      const shortSha = response.result.commitSha?.slice(0, 8) ?? t("gitCommitCreated");
      setCommitSha(shortSha);
      setCommitMessage("");
      if (response.result.snapshot) acceptSnapshot(response.result.snapshot);
      else void refresh();
      if (response.result.warning) pushNotification(response.result.warning, "warning");
      pushNotification(t("gitCommitSuccess", { sha: shortSha }), "success");
    } catch (requestError) {
      if (requestGeneration === generation.current) {
        setError(requestError instanceof Error ? requestError.message : t("gitCommitFailed"));
      }
    } finally {
      if (requestGeneration === generation.current) setOperation(null);
    }
  };

  if (!host || !workspace) {
    return <GitEmptyState title={t("gitNoWorkspace")} detail={t("gitNoWorkspaceDetail")} />;
  }

  if (!snapshot && loading) {
    return <div className="flex min-h-0 flex-1 items-center justify-center text-muted"><LoaderCircle className="animate-spin" size={20} aria-label={t("gitLoading")} /></div>;
  }

  if (!ready) {
    const title = snapshot?.state === "not_repository"
      ? t("gitNotRepository")
      : snapshot?.state === "unavailable"
        ? t("gitUnavailable")
        : t("gitLoadFailed");
    const detail = snapshot && "message" in snapshot ? snapshot.message : error ?? t("gitNotRepositoryDetail");
    return <GitEmptyState title={title} detail={detail} loading={loading} onRefresh={() => void refresh()} />;
  }

  if (selection) {
    return (
      <DiffView
        selection={selection}
        diff={diff}
        loading={diffLoading}
        error={error}
        onBack={() => { setSelection(null); setDiff(null); setError(null); }}
        t={t}
      />
    );
  }

  const branchLabel = ready.unborn
    ? t("gitUnbornBranch", { branch: ready.branch ?? t("gitUnknownBranch") })
    : ready.detached
      ? t("gitDetached", { sha: ready.headSha?.slice(0, 8) ?? "?" })
      : ready.branch ?? t("gitUnknownBranch");

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <header className="shrink-0 border-b border-border px-3 py-2.5">
        <div className="flex items-start gap-2">
          <GitCompareArrows size={16} className="mt-0.5 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium" title={ready.repositoryRoot}>{branchLabel}</span>
              {ready.ahead > 0 && <span className="inline-flex items-center gap-0.5 text-xs text-muted"><ArrowUp size={11} />{ready.ahead}</span>}
              {ready.behind > 0 && <span className="inline-flex items-center gap-0.5 text-xs text-muted"><ArrowDown size={11} />{ready.behind}</span>}
              <span className="ml-auto shrink-0 text-xs tabular-nums text-muted">{t("gitChangeCount", { count: ready.files.length })}</span>
            </div>
            <p className="mt-0.5 truncate font-mono text-[10px] text-muted" title={ready.repositoryRoot}>{ready.repositoryRoot}</p>
          </div>
          <button type="button" title={t("gitRefresh")} aria-label={t("gitRefresh")} disabled={loading || Boolean(operation)} className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40" onClick={() => void refresh()}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      {!ready.workspaceIsRepositoryRoot && (
        <div className="flex shrink-0 items-start gap-2 border-b border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{t("gitParentRepositoryWarning")}</span>
        </div>
      )}
      {ready.warnings.map((warning) => <div key={warning} className="shrink-0 border-b border-warning/35 bg-warning/10 px-3 py-1.5 text-xs text-warning">{warning}</div>)}
      {error && <div role="alert" className="shrink-0 border-b border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}

      <div ref={listRef} role="list" className="min-h-0 flex-1 overflow-auto" aria-label={t("gitChangesList")}>
        {rows.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-muted">
            <Check size={24} />
            <p className="text-sm">{t("gitClean")}</p>
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]!;
              return (
                <div key={virtualRow.key} className="absolute left-0 top-0 w-full" style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}>
                  {row.kind === "header" ? (
                    <div className="flex h-full items-center border-b border-border bg-surface-raised/55 px-3 text-[11px] font-semibold uppercase text-muted">
                      <span>{row.area === "staged" ? t("gitStagedChanges") : t("gitChanges")}</span>
                      <span className="ml-auto tabular-nums">{row.count}</span>
                    </div>
                  ) : (
                    <FileRow
                      row={row}
                      busy={Boolean(operation)}
                      active={operation === `${row.area === "unstaged" ? "git.stage" : "git.unstage"}:${row.file.path}`}
                      onOpen={() => void loadDiff({ path: row.file.path, area: row.area })}
                      onMutate={() => void mutate(row.file, row.area)}
                      t={t}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-border bg-surface p-3">
        {hasConflicts && <p className="mb-2 text-xs text-warning">{t("gitResolveConflicts")}</p>}
        {commitSha && <p role="status" className="mb-2 flex items-center gap-1.5 text-xs text-success"><Check size={12} />{t("gitCommitSuccess", { sha: commitSha })}</p>}
        <label htmlFor="git-commit-message" className="mb-1.5 block text-[11px] font-medium text-muted">{t("gitCommitMessage")}</label>
        <textarea
          id="git-commit-message"
          value={commitMessage}
          maxLength={16 * 1024}
          rows={3}
          disabled={Boolean(operation)}
          placeholder={stagedCount > 0 ? t("gitCommitPlaceholder") : t("gitStageBeforeCommit")}
          className="w-full resize-none rounded border border-border bg-surface-raised px-2.5 py-2 text-sm outline-none placeholder:text-muted focus:border-accent disabled:opacity-50"
          onChange={(event) => setCommitMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void commit();
            }
          }}
        />
        <button type="button" disabled={!canCommit} className="mt-2 flex h-8 w-full items-center justify-center gap-2 rounded bg-accent px-3 text-xs font-medium text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-40" onClick={() => void commit()}>
          {operation === "commit" ? <LoaderCircle size={13} className="animate-spin" /> : <GitCommitHorizontal size={13} />}
          {operation === "commit" ? t("gitCommitting") : t("gitCommit")}
        </button>
      </footer>
    </div>
  );
}

function FileRow({ row, busy, active, onOpen, onMutate, t }: { row: Extract<ListRow, { kind: "file" }>; busy: boolean; active: boolean; onOpen: () => void; onMutate: () => void; t: Translate }) {
  const { name, directory } = splitPath(row.file.path);
  const change = row.file[row.area]!;
  const actionLabel = row.area === "unstaged" ? t("gitStageFile", { path: row.file.path }) : t("gitUnstageFile", { path: row.file.path });
  const diffLabel = `${row.area === "staged" ? t("gitStagedChanges") : t("gitChanges")}: ${row.file.path}`;
  const ActionIcon = row.area === "unstaged" ? Plus : Undo2;
  return (
    <div role="listitem" className="group flex h-full min-w-0 items-center border-b border-border/60 px-2 hover:bg-surface-overlay">
      <button type="button" aria-label={diffLabel} disabled={!row.file.pathSupported} className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-55" title={row.file.path} onClick={onOpen}>
        <FileCode2 size={14} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs"><span className="text-foreground">{name}</span>{directory && <span className="ml-1.5 text-[10px] text-muted">{directory}</span>}</span>
        {row.file.submodule && <span className="shrink-0 text-[9px] uppercase text-muted">{t("gitSubmodule")}</span>}
        <span title={changeLabel(change, t)} aria-label={changeLabel(change, t)} className={`w-4 shrink-0 text-center font-mono text-xs font-semibold ${change === "conflicted" ? "text-warning" : change === "deleted" ? "text-danger" : "text-accent"}`}>{gitChangeLetter(change)}</span>
      </button>
      <button type="button" title={actionLabel} aria-label={actionLabel} disabled={busy || !row.file.pathSupported} className="ml-1 flex size-7 shrink-0 items-center justify-center rounded text-muted opacity-0 hover:bg-surface-raised hover:text-foreground focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-30 group-hover:opacity-100" onClick={onMutate}>
        {active ? <LoaderCircle size={13} className="animate-spin" /> : <ActionIcon size={13} />}
      </button>
    </div>
  );
}

function GitEmptyState({ title, detail, loading = false, onRefresh }: { title: string; detail: string; loading?: boolean; onRefresh?: () => void }) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <GitCompareArrows size={28} className="text-muted" />
      <div><p className="text-sm font-medium">{title}</p><p className="mt-1 text-xs leading-5 text-muted">{detail}</p></div>
      {onRefresh && <button type="button" disabled={loading} className="flex h-8 items-center gap-2 rounded border border-border px-3 text-xs text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-40" onClick={onRefresh}><RefreshCw size={13} className={loading ? "animate-spin" : ""} />{t("gitRefresh")}</button>}
    </div>
  );
}

function DiffView({ selection, diff, loading, error, onBack, t }: { selection: DiffSelection; diff: GitDiffSnapshot | null; loading: boolean; error: string | null; onBack: () => void; t: Translate }) {
  const lines = useMemo(() => parseUnifiedDiffLines(diff?.patch ?? ""), [diff?.patch]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
        <button type="button" title={t("gitBackToChanges")} aria-label={t("gitBackToChanges")} className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent" onClick={onBack}><ArrowLeft size={14} /></button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={selection.path}>{selection.path}</span>
        {diff && <span className="shrink-0 text-[11px]"><span className="text-success">+{diff.additions}</span><span className="ml-1.5 text-danger">-{diff.deletions}</span></span>}
      </header>
      {diff?.truncated && <div className="shrink-0 border-b border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning">{t("gitDiffTruncated")}</div>}
      {error && <div role="alert" className="shrink-0 border-b border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}
      <div className="min-h-0 flex-1 overflow-auto bg-surface-raised/25">
        {loading ? <div className="flex h-full items-center justify-center text-muted"><LoaderCircle size={20} className="animate-spin" /></div>
          : diff?.binary ? <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted"><FileCode2 size={24} /><p className="text-sm">{t("gitBinaryDiff")}</p></div>
          : diff && !diff.patch ? <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">{t("gitEmptyDiff")}</div>
          : <div className="min-w-max py-1 font-mono text-[11px] leading-5">{lines.map((line, index) => <div key={`${index}:${line.content}`} className={`grid grid-cols-[3rem_3rem_minmax(max-content,1fr)] ${line.kind === "addition" ? "bg-success/10 text-success" : line.kind === "deletion" ? "bg-danger/10 text-danger" : line.kind === "hunk" ? "bg-accent/10 text-accent" : line.kind === "meta" ? "text-muted" : "text-foreground/80"}`}><span className="select-none border-r border-border/50 px-1.5 text-right text-muted/65">{line.oldLine ?? ""}</span><span className="select-none border-r border-border/50 px-1.5 text-right text-muted/65">{line.newLine ?? ""}</span><pre className="px-2 whitespace-pre">{line.content || " "}</pre></div>)}</div>}
      </div>
    </div>
  );
}
