import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";

export function ChatHeader() {
  const t = useT();
  const session = useAppStore((s) => s.session);
  const sessionName = session?.name?.trim() || t("chatNewConversation");
  const runtimeLabel = session?.isStreaming
    ? t("chatStatusStreaming")
    : session?.isCompacting
      ? t("chatStatusCompacting")
      : session?.isRetrying
        ? t("chatStatusRetrying")
        : session?.isIdle
          ? t("chatStatusReady")
          : t("chatStatusWorking");

  return (
    <div
      className="flex h-11 shrink-0 items-center gap-4 pl-5 pr-[180px]"
      data-chat-header
      data-tauri-drag-region
    >
      <div className="pointer-events-none min-w-0 flex-1">
        <div className="flex items-end gap-2">
          <h1 className="truncate text-base font-semibold" title={sessionName}>
            {sessionName}
          </h1>
          <span className="mb-0.5 flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                session?.isStreaming || (session && !session.isIdle) ? "bg-success" : "bg-muted"
              }`}
              title={session ? runtimeLabel : t("chatNoActiveSession")}
            />
            <span>{session ? runtimeLabel : t("chatNoActiveSession")}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
