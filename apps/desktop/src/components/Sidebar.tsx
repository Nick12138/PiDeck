import {
  MessageCirclePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useAppStore, type NavPage } from "../lib/stores/app-store";
import { SessionList } from "../features/sessions/SessionList";
import { useT } from "../lib/i18n/use-t";
import { WorkspacePicker } from "../features/workspaces/WorkspacePicker";
import { PiMark } from "./PiMark";
import { sidebarPref, setSidebarPref } from "../lib/sidebar-prefs";
import {
  createNewSession,
  isCreateSessionPending,
  subscribeCreateSessionPending,
} from "../lib/commands/actions";

const SIDEBAR_WIDTH_KEY = "pideck.sidebar.width.v1";
const DEFAULT_SIDEBAR_WIDTH = 268;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;

/** Sidebar collapse toggle rendered in the app-level AppTopBar. Shows the Pi
 *  mark by default and reveals the PanelLeft close/open arrow on hover/focus,
 *  so the same control drives both brand identity and collapse state. */
export function SidebarBrandToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
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
      className="group relative flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      onClick={onToggle}
    >
      <PiMark className="mac-sidebar-brand-mark size-7 transition-opacity group-hover:opacity-0 group-focus:opacity-0" />
      <PanelIcon
        size={15}
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
      className="theme-sidebar-primary interface-density-primary-row flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
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
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(() =>
    sidebarPref("pideck.sidebar.sessionsCollapsed"),
  );
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);

  // Expose the live sidebar width as a root CSS var so sibling chrome (the top
  // bar's title column) can align its start to the content-area's left edge.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      "--sidebar-width",
      `${sidebarCollapsed ? 0 : sidebarWidth}px`,
    );
    return () => root.style.removeProperty("--sidebar-width");
  }, [sidebarWidth, sidebarCollapsed]);

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

  return (
    <Fragment>
      <aside
        style={{
          width: sidebarCollapsed ? 0 : sidebarWidth,
        }}
        data-sidebar
        data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
        className={`sidebar-edge-shadow relative flex shrink-0 flex-col overflow-hidden bg-sidebar ${
          resizing ? "transition-none" : "transition-[width] duration-200 ease-out"
        }`}
      >
        {!sidebarCollapsed && (
          <div
            role="separator"
            tabIndex={0}
            data-sidebar-resizer
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
            <div className="px-2 pb-3 pt-[14px]">
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
                className={`flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-[13px] transition-colors ${
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
          </>
        )}
      </aside>
    </Fragment>
  );
}
