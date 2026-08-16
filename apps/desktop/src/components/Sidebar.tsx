import {
  MessageCirclePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
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

const SIDEBAR_WIDTH_KEY = "pideck.sidebar.width.v1";
const DEFAULT_SIDEBAR_WIDTH = 268;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;

function SidebarBrandToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const t = useT();
  const label = collapsed ? t("sidebarExpand") : t("sidebarCollapse");
  const PanelIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      data-sidebar-brand-toggle
      className="group relative flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      onClick={onToggle}
    >
      <PiMark className="mac-sidebar-brand-mark size-8 transition-opacity group-hover:opacity-0 group-focus:opacity-0" />
      <PanelIcon
        size={18}
        className="absolute text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100"
      />
    </button>
  );
}

function clampSidebarWidth(width: number, viewportWidth = 1280): number {
  const responsiveMax = Math.max(
    DEFAULT_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, viewportWidth - 360),
  );
  if (!Number.isFinite(width)) return Math.min(DEFAULT_SIDEBAR_WIDTH, responsiveMax);
  return Math.min(responsiveMax, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function initialSidebarWidth(): number {
  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
  try {
    const stored = Number(globalThis.localStorage?.getItem(SIDEBAR_WIDTH_KEY));
    return clampSidebarWidth(stored || DEFAULT_SIDEBAR_WIDTH, viewportWidth);
  } catch {
    return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, viewportWidth);
  }
}

function NewSessionButton() {
  const t = useT();
  const workspace = useAppStore((s) => s.workspace);
  const [pending, setPending] = useState(isCreateSessionPending);
  useEffect(() => subscribeCreateSessionPending(setPending), []);

  return (
    <button
      type="button"
      onClick={() => {
        // Creating a session from Settings/Packages should land on the chat page.
        if (useAppStore.getState().page !== "chat") useAppStore.getState().setPage("chat");
        void createNewSession();
      }}
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
  const [sessionsCollapsed, setSessionsCollapsed] = useState(() =>
    sidebarPref("pideck.sidebar.sessionsCollapsed"),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    sidebarPref("pideck.sidebar.collapsed"),
  );
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);

  function finishResize(target: HTMLDivElement, pointerId: number) {
    if (resizeStart.current?.pointerId !== pointerId) return;
    resizeStart.current = null;
    setResizing(false);
    try {
      globalThis.localStorage?.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current));
    } catch {
      /* ignore unavailable localStorage */
    }
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  }

  function resizeSidebar(width: number) {
    const next = clampSidebarWidth(width, window.innerWidth);
    sidebarWidthRef.current = next;
    setSidebarWidth(next);
  }

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
    <Fragment>
      <aside
        style={{
          width: sidebarCollapsed ? 0 : sidebarWidth,
        }}
        data-sidebar
        data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
        className={`sidebar-edge-shadow relative flex shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar ${
          resizing ? "transition-none" : "transition-[width] duration-200 ease-out"
        }`}
      >
        {!sidebarCollapsed && (
          <div
            role="separator"
            tabIndex={0}
            aria-label={t("sidebarResize")}
            aria-orientation="vertical"
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuenow={sidebarWidth}
            className="absolute -right-1 top-0 z-30 h-full w-2 cursor-col-resize touch-none"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              resizeStart.current = {
                pointerId: event.pointerId,
                x: event.clientX,
                width: sidebarWidth,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              setResizing(true);
            }}
            onPointerMove={(event) => {
              const start = resizeStart.current;
              if (!start || start.pointerId !== event.pointerId) return;
              // sidebar is on the left edge: dragging right (clientX grows) widens it
              resizeSidebar(start.width + (event.clientX - start.x));
            }}
            onPointerUp={(event) => finishResize(event.currentTarget, event.pointerId)}
            onPointerCancel={(event) => finishResize(event.currentTarget, event.pointerId)}
            onLostPointerCapture={() => {
              resizeStart.current = null;
              setResizing(false);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const next = clampSidebarWidth(
                sidebarWidth + (event.key === "ArrowRight" ? 20 : -20),
                window.innerWidth,
              );
              sidebarWidthRef.current = next;
              setSidebarWidth(next);
              try {
                globalThis.localStorage?.setItem(SIDEBAR_WIDTH_KEY, String(next));
              } catch {
                /* ignore unavailable localStorage */
              }
            }}
          />
        )}

        {sidebarCollapsed ? null : (
          <>
            <div
              className="flex h-16 shrink-0 items-center gap-3 px-4"
              data-sidebar-header
              data-tauri-drag-region
            >
              <SidebarBrandToggle collapsed={false} onToggle={toggleSidebarCollapsed} />
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
              </div>
            </div>

            <div className="px-2 pb-3 pt-2">
              <NewSessionButton />
            </div>

            <div className="px-2 pb-3">
              <button
                type="button"
                onClick={() => setPage(page === "chat" ? "settings" : "chat")}
                data-ui="nav-item"
                data-state={page !== "chat" ? "active" : "inactive"}
                title={t("settingsTitle")}
                aria-label={t("settingsTitle")}
                aria-pressed={page !== "chat"}
                className={`flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm font-medium transition-colors ${
                  page !== "chat"
                    ? "theme-nav-active bg-nav-active text-nav-active-foreground"
                    : "text-foreground hover:bg-surface-overlay"
                }`}
              >
                <Settings size={18} className="shrink-0" />
                <span>{t("settingsTitle")}</span>
              </button>
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

            <div className="shrink-0 flex items-center justify-end px-2 pb-2">
              <NotificationCenter />
            </div>
          </>
        )}
      </aside>

      {sidebarCollapsed && (
        <div
          className="fixed left-0 top-0 z-40 flex h-12 w-14 items-center justify-center"
          data-sidebar-collapsed-toggle-slot
          data-tauri-drag-region
        >
          <div className="translate-x-0.5 translate-y-[3px]">
            <SidebarBrandToggle collapsed onToggle={toggleSidebarCollapsed} />
          </div>
        </div>
      )}
    </Fragment>
  );
}
