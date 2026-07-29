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
      className="flex h-11 shrink-0 items-center gap-4 border-b border-border pl-5 pr-[180px]"
      data-chat-header
      data-tauri-drag-region
    >
      <div className="pointer-events-none min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-sm font-semibold" title={sessionName}>
            {sessionName}
          </h1>
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              session?.isStreaming || (session && !session.isIdle)
                ? "bg-success"
                : "bg-muted"
            }`}
            title={session ? runtimeLabel : t("chatNoActiveSession")}
          />
          <span className="text-[11px] text-muted">
            {session ? runtimeLabel : t("chatNoActiveSession")}
          </span>
        </div>
      </div>
    </div>
  );
}
