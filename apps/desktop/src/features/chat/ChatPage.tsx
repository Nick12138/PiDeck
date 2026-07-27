import { useAppStore } from "../../lib/stores/app-store";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { ChatHeader } from "./ChatHeader";
import { InlineExtensionUiRequest } from "./InlineExtensionUiRequest";
import { workspaceDisplayName } from "../workspaces/WorkspacePicker";
import { useT } from "../../lib/i18n/use-t";

export function ChatPage() {
  const t = useT();
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const host = useAppStore((s) => s.host);
  const packages = useAppStore((s) => s.packages);

  const authBlocked =
    host?.lastError?.code === "AUTH_REQUIRED" ||
    host?.fatalError?.code === "AUTH_REQUIRED";
  const resourceReloadBlocked = packages?.resourceReloadRequired === true;
  const reconcileBlocked = packages?.mutation?.reconcileRequired === true;
  const packageBlocked = resourceReloadBlocked || reconcileBlocked;
  const isNewConversation = Boolean(
    session && session.messages.length === 0 && session.isIdle,
  );

  if (!workspace) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted">
        <p className="text-base text-foreground">{t("chatSelectWorkspaceTitle")}</p>
        <p className="text-sm">{t("chatSelectWorkspaceHint")}</p>
      </div>
    );
  }

  if (!workspace.servicesReady) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted">
        {t("chatWorkspaceServicesNotReady")}
        {host?.lastError?.message ? (
          <span className="ml-2 text-danger">{host.lastError.message}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader />
      {authBlocked && (
        <div className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
          {t("chatAuthRequired", { agentDir: host?.agentDir ?? "" })}
        </div>
      )}
      {packageBlocked && (
        <div className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
          {reconcileBlocked
            ? t("chatPackageReconcileRequired")
            : t("chatPackageReloadRequired")}
        </div>
      )}
      {session ? (
        isNewConversation ? (
          <>
            <InlineExtensionUiRequest />
            <Composer
              disabled={authBlocked || packageBlocked}
              welcomeWorkspaceName={workspaceDisplayName(workspace.cwd)}
            />
          </>
        ) : (
          <>
            <Transcript />
            <InlineExtensionUiRequest />
            <Composer disabled={authBlocked || packageBlocked} />
          </>
        )
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          {t("chatNoSession")}
        </div>
      )}
    </div>
  );
}
