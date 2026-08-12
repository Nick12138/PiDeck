import {
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  MessageCirclePlus,
  Search,
  Settings,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useAppStore, type NavPage } from "../lib/stores/app-store";
import { SessionList } from "../features/sessions/SessionList";
import { useT } from "../lib/i18n/use-t";
import { WorkspacePicker } from "../features/workspaces/WorkspacePicker";
import { sidebarPref, setSidebarPref } from "../lib/sidebar-prefs";
import { PiMark } from "./PiMark";
import { NotificationCenter } from "./NotificationCenter";
import {
  createNewSession,
  isCreateSessionPending,
  subscribeCreateSessionPending,
} from "../lib/commands/actions";
import { requestGlobalSearchOpen, subscribeSidebarToggle } from "../lib/commands/events";

function NewSessionButton() {
  const t = useT();
  const workspace = useAppStore((s) => s.workspace);
  const [pending, setPending] = useState(isCreateSessionPending);
  useEffect(() => subscribeCreateSessionPending(setPending), []);

  return (
    <button
      type="button"
      onClick={() => void createNewSession()}
      disabled={!workspace?.servicesReady || pending}
      className="theme-sidebar-primary interface-density-primary-row flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm font-medium transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
    >
      <MessageCirclePlus size={18} className="shrink-0" />
      <span>{pending ? t("sidebarCreating") : t("sidebarNewConversation")}</span>
    </button>
  );
}

export function Sidebar() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);

  return <SidebarLayout page={page} setPage={setPage} />;
}

export function SidebarLayout({
  page,
  setPage,
}: {
  page: NavPage;
  setPage: (page: NavPage) => void;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const hostFatal = useAppStore((s) => s.hostFatal);
  const connecting = useAppStore((s) => s.connecting);
  const rehydrating = useAppStore((s) => s.rehydrating);
  const desynchronized = useAppStore((s) => s.desynchronized);
  const hostReady = host?.phase === "ready" || host?.phase === "waitingForWorkspace";
  const connectionPending = !hostFatal && (connecting || rehydrating || desynchronized);
  const connectionTitle = hostFatal
    ? t("sidebarHostOffline")
    : connecting
      ? t("sidebarConnecting")
      : desynchronized
        ? t("sidebarResync")
        : rehydrating
          ? t("sidebarLoadingSnapshots")
          : (host?.phase ?? t("sidebarHostOffline"));
  const [sessionsCollapsed, setSessionsCollapsed] = useState(() =>
    sidebarPref("pideck.sidebar.sessionsCollapsed"),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    sidebarPref("pideck.sidebar.collapsed"),
  );

  function toggleSessionsCollapsed() {
    setSessionsCollapsed((current) => {
      setSidebarPref("pideck.sidebar.sessionsCollapsed", !current);
      return !current;
    });
  }

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((current) => {
      setSidebarPref("pideck.sidebar.collapsed", !current);
      return !current;
    });
  }

  useEffect(() => subscribeSidebarToggle(toggleSidebarCollapsed), []);

  return (
    <aside
      style={{ marginLeft: sidebarCollapsed ? -268 : 0 }}
      data-sidebar
      data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
      className="sidebar-edge-shadow relative flex w-[268px] shrink-0 flex-col border-r border-border bg-sidebar transition-[margin-left] duration-200 ease-out"
    >
      <div className="group/sidebar-edge absolute -right-4 top-0 z-40 h-full w-4">
        <button
          type="button"
          title={sidebarCollapsed ? t("sidebarExpand") : t("sidebarCollapse")}
          aria-label={sidebarCollapsed ? t("sidebarExpand") : t("sidebarCollapse")}
          aria-expanded={!sidebarCollapsed}
          className="absolute top-1/2 flex h-12 w-4 -translate-y-1/2 items-center justify-center rounded-r-md border border-l-0 border-border bg-surface-raised text-muted opacity-0 shadow-sm transition-opacity group-hover/sidebar-edge:opacity-100 hover:text-foreground focus-visible:opacity-100"
          onClick={toggleSidebarCollapsed}
        >
          {sidebarCollapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>
      </div>

      {sidebarCollapsed ? null : (
        <>
          <div
            className="flex h-16 shrink-0 items-center gap-3 px-4"
            data-sidebar-header
            data-tauri-drag-region
          >
            <PiMark className="mac-sidebar-brand-mark size-8" />
            <span className="text-[15px] font-semibold" data-sidebar-brand>
              Pi Agent
            </span>
            <div className="ml-auto flex items-center gap-0.5">
              <button
                type="button"
                title={t("commandGlobalSearch")}
                aria-label={t("commandGlobalSearch")}
                disabled={!host}
                className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
                onClick={requestGlobalSearchOpen}
              >
                <Search size={15} />
              </button>
              <NotificationCenter />
            </div>
          </div>

          <div className="px-2 pb-3 pt-2">
            <NewSessionButton />
          </div>

          <div className="border-t border-border px-2 py-3">
            <WorkspacePicker />
          </div>

          {/* Collapsed or not, the header row stays in place below Workspaces. */}
          <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <SessionList
              showCreateAction={false}
              collapsed={sessionsCollapsed}
              onToggleCollapsed={toggleSessionsCollapsed}
            />
          </div>

          <div className="shrink-0 border-t border-border p-2">
            <button
              type="button"
              onClick={() => setPage(page === "chat" ? "settings" : "chat")}
              data-ui="nav-item"
              data-state={page !== "chat" ? "active" : "inactive"}
              className={`interface-density-primary-row flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm transition-colors ${
                page !== "chat"
                  ? "theme-nav-active bg-nav-active text-nav-active-foreground"
                  : "text-foreground hover:bg-surface-overlay"
              }`}
            >
              <Settings size={17} />
              <span className="flex-1">{t("settingsTitle")}</span>
              {connectionPending ? (
                <span className="flex shrink-0" title={connectionTitle}>
                  <LoaderCircle size={14} className="animate-spin text-muted" />
                </span>
              ) : (
                <span
                  className={`size-1.5 rounded-full ${
                    hostFatal
                      ? "bg-danger"
                      : hostReady
                        ? "bg-success"
                        : host
                          ? "bg-warning"
                          : "bg-muted"
                  }`}
                  title={connectionTitle}
                />
              )}
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
