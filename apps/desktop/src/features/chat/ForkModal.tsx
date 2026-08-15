import { useEffect, useState } from "react";
import { GitFork, LoaderCircle, X } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "../../lib/bridge/host-context";
import { requestFork } from "../../lib/fork-actions";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { useT } from "../../lib/i18n/use-t";

type ForkPoint = { entryId: string; text: string };

export function ForkModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const session = useAppStore((s) => s.session);
  const [items, setItems] = useState<ForkPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);

  const hostInstanceId = useAppStore((s) => s.host?.hostInstanceId);
  const workspaceId = useAppStore((s) => s.workspace?.id);
  const workspaceRevision = useAppStore((s) => s.workspace?.revision);
  const sessionId = session?.sessionId;
  const sessionRevision = session?.revision;
  const busy = session ? !session.isIdle : true;

  useEffect(() => {
    if (!open) return;
    const current = useAppStore.getState();
    if (!current.host || !current.workspace || !current.session) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    setForking(null);
    const generation = captureRequestGeneration(current.host);
    void requestWithRetry(
      () =>
        hostClient.request(
          "session.getForkPoints",
          activeSessionContext(current.host!, current.workspace!, current.session!),
          null,
        ),
      undefined,
      () => !cancelled,
    )
      .then((res) => {
        if (cancelled || !res) return;
        if (
          !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
            session: true,
          })
        ) {
          return;
        }
        if (!res.ok) {
          setError(localizeHostError(res.error, t));
          return;
        }
        setItems(res.result.items);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t("forkLoadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, hostInstanceId, workspaceId, workspaceRevision, sessionId, sessionRevision, t]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  async function fork(entryId: string) {
    if (forking) return;
    setForking(entryId);
    const forked = await requestFork(entryId);
    setForking(null);
    if (forked) onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="fork-modal-title"
        className="theme-floating-surface flex max-h-[70vh] w-full max-w-md flex-col rounded-xl border border-border bg-surface-raised p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between gap-3">
          <h2 id="fork-modal-title" className="flex items-center gap-2 text-base font-semibold">
            <GitFork size={15} className="text-muted" /> {t("forkTitle")}
          </h2>
          <button
            type="button"
            title={t("commonClose")}
            aria-label={t("commonClose")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        <p className="mb-3 text-xs text-muted">{t("forkIntro")}</p>
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : items === null ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <LoaderCircle size={13} className="animate-spin" /> {t("forkLoading")}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted">{t("forkEmpty")}</p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {items.map((item, index) => (
              <button
                key={item.entryId}
                type="button"
                disabled={busy || forking !== null}
                title={item.text}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/85 hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void fork(item.entryId)}
              >
                {forking === item.entryId ? (
                  <LoaderCircle size={12} className="shrink-0 animate-spin" />
                ) : (
                  <span className="shrink-0 tabular-nums text-muted">{index + 1}.</span>
                )}
                <span className="min-w-0 flex-1 truncate">{item.text}</span>
              </button>
            ))}
          </div>
        )}
        {busy && <p className="mt-3 text-[11px] text-muted">{t("forkBusy")}</p>}
      </div>
    </div>
  );
}
