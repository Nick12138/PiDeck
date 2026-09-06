import { LoaderCircle, RefreshCw, Send } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useT } from "../../lib/i18n/use-t";
import { buildTranscriptRows } from "../chat/transcript-model";
import { TranscriptRowView } from "../chat/Transcript";
import { telegramSessionTitle } from "./TelegramSessionList";
import { useTelegramViewStore } from "./telegram-view-store";

/**
 * Main-pane read-only view for the telegram workspace: renders the currently
 * opened telegram-driven session as a full Pi transcript (user prompts, bot
 * thinking, tool calls and replies), reusing the read-only renderer. No
 * composer, no send path — viewing only. Polls the session list every 10s so
 * new sessions appear; the open session itself is snapshotted once.
 */
export function TelegramHistoryView() {
  const t = useT();
  const profile = useTelegramViewStore((s) => s.profile);
  const sessionDetail = useTelegramViewStore((s) => s.sessionDetail);
  const detailLoading = useTelegramViewStore((s) => s.detailLoading);
  const detailError = useTelegramViewStore((s) => s.detailError);
  const refresh = useTelegramViewStore((s) => s.refreshTelegramSessions);

  // Re-scan for new telegram sessions while the view is mounted.
  useEffect(() => {
    const interval = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const rows = useMemo(
    () =>
      sessionDetail
        ? buildTranscriptRows([], { entries: sessionDetail.entries, turnActive: false })
        : [],
    [sessionDetail],
  );

  const botLabel = profile?.botUsername ? `@${profile.botUsername}` : "Telegram";
  const title = sessionDetail ? telegramSessionTitle(sessionDetail.summary) : botLabel;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-telegram-history-view>
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Send size={15} className="shrink-0 text-accent" />
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
          title={t("tgSessionsRefresh")}
          aria-label={t("tgSessionsRefresh")}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {detailLoading ? (
          <div className="flex h-full items-center justify-center text-muted">
            <LoaderCircle size={18} className="animate-spin" />
          </div>
        ) : detailError ? (
          <div className="flex flex-col items-center gap-2 py-10 text-sm text-danger">
            <span>{detailError}</span>
          </div>
        ) : sessionDetail ? (
          <div className="transcript">
            {rows.map((row) => (
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
                  userCollapsible={false}
                  userExpanded={false}
                  onToggleUser={undefined}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 py-10 text-sm text-muted">
            <Send size={20} className="mb-1 opacity-60" />
            <p>{t("tgSessionPickHint")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
