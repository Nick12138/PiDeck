import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderTree,
  GitBranch,
  Globe2,
  LoaderCircle,
  Plus,
  RotateCcw,
  SquareTerminal,
  X,
} from "lucide-react";
import type { TerminalProfileId } from "@pideck/protocol";
import { useAppStore } from "../lib/stores/app-store";
import { setSidebarPref } from "../lib/sidebar-prefs";
import { PiMark } from "./PiMark";
import {
  ExtensionTerminal,
  cancelExtensionTerminal,
} from "../features/dock/ExtensionTerminal";
import {
  ShellTerminal,
  shellTerminalLabel,
  type ShellTerminalStatus,
} from "../features/dock/ShellTerminal";
import { FilesPanel } from "../features/dock/FilesPanel";
import { BrowserPanel } from "../features/dock/BrowserPanel";
import { TreePanel } from "../features/dock/TreePanel";
import { subscribeTreePanel } from "../lib/dock-tree";

export type DockTabId =
  | "files"
  | "tree"
  | `browser:${number}`
  | `shell:${number}`
  | `extension:${string}`;

type ShellDockTab = {
  id: number;
  generation: number;
  cwd: string;
  profileId: TerminalProfileId;
  status: ShellTerminalStatus | null;
};

type BrowserDockTab = {
  id: number;
  title: string;
};

const DOCK_WIDTH_KEY = "pideck.dock.width.v1";
const DEFAULT_DOCK_WIDTH = 460;
const MIN_DOCK_WIDTH = 460;
const MAX_DOCK_WIDTH = 720;
const MAX_BROWSER_TABS = 8;
const MIN_TAB_WIDTH = 96;
const TAB_GAP = 4;
const TAB_CONTROL_WIDTH = 28;

function shellTabId(id: number): DockTabId {
  return `shell:${id}`;
}

function browserTabId(id: number): DockTabId {
  return `browser:${id}`;
}

function extensionTabId(requestId: string): DockTabId {
  return `extension:${requestId}`;
}

function shellTitle(tab: ShellDockTab): string {
  const title = tab.status?.title ?? "Shell";
  const cwd = shellTerminalLabel(tab.status?.cwd ?? tab.cwd);
  return `${title} - ${cwd}`;
}

export function visibleDockTabLimit(availableWidth: number, tabCount: number): number {
  if (tabCount <= 0) return 0;
  const widthWithoutMenu = Math.max(0, availableWidth - TAB_CONTROL_WIDTH - TAB_GAP);
  const allTabsWidth = tabCount * MIN_TAB_WIDTH + Math.max(0, tabCount - 1) * TAB_GAP;
  if (allTabsWidth <= widthWithoutMenu) return tabCount;
  const widthWithMenu = Math.max(
    0,
    availableWidth - TAB_CONTROL_WIDTH * 2 - TAB_GAP * 2,
  );
  return Math.max(
    1,
    Math.min(tabCount, Math.floor((widthWithMenu + TAB_GAP) / (MIN_TAB_WIDTH + TAB_GAP))),
  );
}

export function partitionDockTabs<T extends string>(
  tabIds: readonly T[],
  activeTab: T | null,
  visibleLimit: number,
): { visible: T[]; overflow: T[] } {
  const limit = Math.max(0, Math.min(tabIds.length, visibleLimit));
  if (tabIds.length <= limit) return { visible: [...tabIds], overflow: [] };
  const visible = tabIds.slice(0, limit);
  if (activeTab && tabIds.includes(activeTab) && !visible.includes(activeTab) && limit > 0) {
    visible[limit - 1] = activeTab;
  }
  return {
    visible,
    overflow: tabIds.filter((tabId) => !visible.includes(tabId)),
  };
}

export function clampDockWidth(width: number, viewportWidth = 1280): number {
  const responsiveMax = Math.max(
    DEFAULT_DOCK_WIDTH,
    Math.min(MAX_DOCK_WIDTH, viewportWidth - 360),
  );
  if (!Number.isFinite(width)) return Math.min(DEFAULT_DOCK_WIDTH, responsiveMax);
  return Math.min(responsiveMax, Math.max(MIN_DOCK_WIDTH, Math.round(width)));
}

function initialDockWidth(): number {
  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
  try {
    const stored = Number(globalThis.localStorage?.getItem(DOCK_WIDTH_KEY));
    return clampDockWidth(stored || DEFAULT_DOCK_WIDTH, viewportWidth);
  } catch {
    return clampDockWidth(DEFAULT_DOCK_WIDTH, viewportWidth);
  }
}

export function RightDock() {
  const dockOpen = useAppStore((state) => state.dockOpen);
  const panel = useAppStore((state) => state.extensionTerminal);
  const workspaceCwd = useAppStore((state) => state.workspace?.canonicalCwd ?? null);
  const terminalProfile = useAppStore(
    (state) => state.desktopSettings?.terminalProfile ?? "auto",
  );
  const setDockOpen = useAppStore((state) => state.setDockOpen);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const initialExtensionTab = panel ? extensionTabId(panel.requestId) : null;
  const [activeTab, setActiveTab] = useState<DockTabId | null>(initialExtensionTab);
  const [tabOrder, setTabOrder] = useState<DockTabId[]>(
    initialExtensionTab ? [initialExtensionTab] : [],
  );
  const [shellTabs, setShellTabs] = useState<ShellDockTab[]>([]);
  const [browserTabs, setBrowserTabs] = useState<BrowserDockTab[]>([]);
  const [extensionClosing, setExtensionClosing] = useState<string | null>(null);
  const [dockWidth, setDockWidth] = useState(initialDockWidth);
  const [resizing, setResizing] = useState(false);
  const [visibleTabLimit, setVisibleTabLimit] = useState(Number.MAX_SAFE_INTEGER);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const nextShellId = useRef(1);
  const nextShellGeneration = useRef(1);
  const nextBrowserId = useRef(1);
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const dockWidthRef = useRef(dockWidth);
  dockWidthRef.current = dockWidth;

  const closeOrderTab = (tabId: DockTabId) => {
    setTabOrder((current) => {
      const index = current.indexOf(tabId);
      if (index < 0) return current;
      const next = current.filter((candidate) => candidate !== tabId);
      setActiveTab((active) =>
        active === tabId ? (next[Math.min(index, next.length - 1)] ?? null) : active,
      );
      return next;
    });
  };

  useEffect(() => {
    if (panel) {
      const tabId = extensionTabId(panel.requestId);
      setExtensionClosing(null);
      setTabOrder((current) => (current.includes(tabId) ? current : [...current, tabId]));
      setActiveTab(tabId);
      return;
    }
    setExtensionClosing(null);
    setTabOrder((current) => {
      const stale = current.find((tabId) => tabId.startsWith("extension:"));
      if (!stale) return current;
      const index = current.indexOf(stale);
      const next = current.filter((tabId) => tabId !== stale);
      setActiveTab((active) =>
        active === stale ? (next[Math.min(index, next.length - 1)] ?? null) : active,
      );
      return next;
    });
  }, [panel?.requestId]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      addMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    });
    const closeOnPointer = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAddMenuOpen(false);
      addButtonRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeOnPointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", closeOnPointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [addMenuOpen]);

  useEffect(() => {
    const tabBar = tabBarRef.current;
    if (!tabBar) return;
    const updateLimit = (width: number) => {
      setVisibleTabLimit(visibleDockTabLimit(width, tabOrder.length));
    };
    updateLimit(tabBar.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateLimit(entry.contentRect.width);
    });
    observer.observe(tabBar);
    return () => observer.disconnect();
  }, [tabOrder.length]);

  const { visible: visibleTabIds, overflow: overflowTabIds } = partitionDockTabs(
    tabOrder,
    activeTab,
    visibleTabLimit,
  );

  const toggle = () => {
    const next = !dockOpen;
    setDockOpen(next);
    setSidebarPref("pideck.dock.open", next);
  };

  const createFiles = () => {
    if (!tabOrder.includes("files")) setTabOrder((current) => [...current, "files"]);
    setActiveTab("files");
    setAddMenuOpen(false);
  };

  const createTree = () => {
    setTabOrder((current) => (current.includes("tree") ? current : [...current, "tree"]));
    setActiveTab("tree");
    setAddMenuOpen(false);
  };

  useEffect(
    () =>
      subscribeTreePanel(() => {
        createTree();
        if (!useAppStore.getState().dockOpen) {
          setDockOpen(true);
          setSidebarPref("pideck.dock.open", true);
        }
        return true;
      }),
    // createTree/setDockOpen are stable within a mount; resubscribing per
    // render would drop queued open requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const createBrowser = () => {
    if (browserTabs.length >= MAX_BROWSER_TABS) return;
    const id = nextBrowserId.current++;
    setBrowserTabs((current) => [...current, { id, title: "Browser" }]);
    const tabId = browserTabId(id);
    setTabOrder((current) => [...current, tabId]);
    setActiveTab(tabId);
    setAddMenuOpen(false);
  };

  const createShell = () => {
    if (!workspaceCwd) return;
    const id = nextShellId.current++;
    const generation = nextShellGeneration.current++;
    setShellTabs((current) => [
      ...current,
      { id, generation, cwd: workspaceCwd, profileId: terminalProfile, status: null },
    ]);
    const tabId = shellTabId(id);
    setTabOrder((current) => [...current, tabId]);
    setActiveTab(tabId);
    setAddMenuOpen(false);
  };

  const closeShell = (id: number) => {
    const tabId = shellTabId(id);
    setShellTabs((current) => current.filter((tab) => tab.id !== id));
    closeOrderTab(tabId);
  };

  const closeBrowser = (id: number) => {
    setBrowserTabs((current) => current.filter((tab) => tab.id !== id));
    closeOrderTab(browserTabId(id));
  };

  const restartShell = (id: number) => {
    const generation = nextShellGeneration.current++;
    setShellTabs((current) =>
      current.map((tab) =>
        tab.id === id ? { ...tab, generation, status: null } : tab,
      ),
    );
    setActiveTab(shellTabId(id));
  };

  const closeExtension = async () => {
    if (!panel || extensionClosing === panel.requestId) return;
    const requestId = panel.requestId;
    setExtensionClosing(requestId);
    const error = await cancelExtensionTerminal(panel);
    if (error) {
      setExtensionClosing((current) => (current === requestId ? null : current));
      pushNotification(error, "error");
      return;
    }
    window.setTimeout(() => {
      if (useAppStore.getState().extensionTerminal?.requestId !== requestId) return;
      setExtensionClosing((current) => (current === requestId ? null : current));
      pushNotification(
        "Extension did not respond to close; use the panel's own exit shortcut",
        "warning",
      );
    }, 1_500);
  };

  const closeTab = (tabId: DockTabId) => {
    if (tabId === "files" || tabId === "tree") {
      closeOrderTab(tabId);
      return;
    }
    if (tabId.startsWith("browser:")) {
      closeBrowser(Number(tabId.slice("browser:".length)));
      return;
    }
    if (tabId.startsWith("shell:")) {
      closeShell(Number(tabId.slice("shell:".length)));
      return;
    }
    void closeExtension();
  };

  const tabInfo = (tabId: DockTabId) => {
    if (tabId === "files") return { label: "Files", Icon: FolderTree };
    if (tabId === "tree") return { label: "Tree", Icon: GitBranch };
    if (tabId.startsWith("browser:")) {
      const id = Number(tabId.slice("browser:".length));
      return {
        label: browserTabs.find((tab) => tab.id === id)?.title ?? "Browser",
        Icon: Globe2,
      };
    }
    if (tabId.startsWith("shell:")) {
      const id = Number(tabId.slice("shell:".length));
      const shell = shellTabs.find((tab) => tab.id === id);
      return { label: shell ? shellTitle(shell) : "Shell", Icon: SquareTerminal };
    }
    return { label: panel?.title ?? "Extension", Icon: SquareTerminal };
  };

  const finishResize = (target: HTMLDivElement, pointerId: number) => {
    if (resizeStart.current?.pointerId !== pointerId) return;
    resizeStart.current = null;
    setResizing(false);
    try {
      globalThis.localStorage?.setItem(DOCK_WIDTH_KEY, String(dockWidthRef.current));
    } catch {
      /* ignore unavailable localStorage */
    }
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  };

  return (
    <aside
      style={{ width: dockWidth, marginRight: dockOpen ? 0 : -dockWidth }}
      className={`relative flex shrink-0 flex-col border-l border-border bg-sidebar ${
        resizing ? "transition-none" : "transition-[margin-right] duration-200 ease-out"
      }`}
    >
      {dockOpen && (
        <div
          role="separator"
          tabIndex={0}
          aria-label="Resize right dock"
          aria-orientation="vertical"
          aria-valuemin={MIN_DOCK_WIDTH}
          aria-valuemax={MAX_DOCK_WIDTH}
          aria-valuenow={dockWidth}
          className="absolute -left-1 top-0 z-30 h-full w-2 cursor-col-resize touch-none hover:bg-accent/20"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            resizeStart.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              width: dockWidth,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
          }}
          onPointerMove={(event) => {
            const start = resizeStart.current;
            if (!start || start.pointerId !== event.pointerId) return;
            const next = clampDockWidth(
              start.width + start.x - event.clientX,
              window.innerWidth,
            );
            dockWidthRef.current = next;
            setDockWidth(next);
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
            const next = clampDockWidth(
              dockWidth + (event.key === "ArrowLeft" ? 20 : -20),
              window.innerWidth,
            );
            dockWidthRef.current = next;
            setDockWidth(next);
            try {
              globalThis.localStorage?.setItem(DOCK_WIDTH_KEY, String(next));
            } catch {
              /* ignore unavailable localStorage */
            }
          }}
        />
      )}

      <button
        type="button"
        title={dockOpen ? "Collapse panel" : "Open panel"}
        aria-label={dockOpen ? "Collapse right panel" : "Open right panel"}
        aria-expanded={dockOpen}
        className={`absolute -left-4 top-1/2 z-40 flex h-12 w-4 -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 border-border bg-surface-raised hover:text-foreground ${
          !dockOpen && panel ? "text-accent" : "text-muted"
        }`}
        onClick={toggle}
      >
        {dockOpen ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </button>

      <div
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center border-b border-border pl-2 pr-[180px]"
      >
        <div ref={tabBarRef} className="flex min-w-0 flex-1 items-center gap-1 self-stretch">
          <div
            role="tablist"
            aria-label="Dock pages"
            className="flex min-w-0 items-end gap-1 self-stretch overflow-hidden pt-1.5"
          >
            {visibleTabIds.map((tabId) => {
              const { label, Icon } = tabInfo(tabId);
              const shell = tabId.startsWith("shell:")
                ? shellTabs.find((tab) => shellTabId(tab.id) === tabId)
                : undefined;
              const restartable =
                shell?.status?.state === "exited" || shell?.status?.state === "error";
              const closing =
                tabId.startsWith("extension:") && extensionClosing === panel?.requestId;
              return (
                <div
                  key={tabId}
                  className={`flex h-full w-44 min-w-[96px] shrink items-center border-b-2 text-xs ${
                    activeTab === tabId
                      ? "border-accent text-foreground"
                      : "border-transparent text-muted hover:text-foreground"
                  }`}
                >
                  <button
                    type="button"
                    role="tab"
                    id={`dock-tab-${tabId}`}
                    aria-controls={`dock-panel-${tabId}`}
                    aria-selected={activeTab === tabId}
                    className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pl-2"
                    title={label}
                    aria-label={label}
                    onClick={() => setActiveTab(tabId)}
                  >
                    {shell?.status?.state === "starting" ? (
                      <LoaderCircle size={13} className="shrink-0 animate-spin" />
                    ) : (
                      <Icon size={13} className="shrink-0" />
                    )}
                    <span className="truncate">{label}</span>
                  </button>
                  {restartable && shell && (
                    <button
                      type="button"
                      title="Restart shell"
                      aria-label={`Restart ${label}`}
                      className="shrink-0 p-1 text-muted hover:text-foreground"
                      onClick={() => restartShell(shell.id)}
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    title={`Close ${label}`}
                    aria-label={`Close ${label}`}
                    disabled={closing}
                    className="shrink-0 p-1 text-muted hover:text-foreground disabled:opacity-60"
                    onClick={() => closeTab(tabId)}
                  >
                    {closing ? <LoaderCircle size={12} className="animate-spin" /> : <X size={12} />}
                  </button>
                </div>
              );
            })}
          </div>

          {overflowTabIds.length > 0 && (
            <details
              open={overflowMenuOpen}
              className="relative shrink-0"
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setOverflowMenuOpen(open);
                if (open) setAddMenuOpen(false);
              }}
            >
              <summary
                title="More tabs"
                aria-label="More tabs"
                className="flex size-7 cursor-pointer list-none items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground [&::-webkit-details-marker]:hidden"
              >
                <ChevronDown size={14} />
              </summary>
              <div className="absolute right-0 top-8 z-50 w-56 overflow-hidden rounded border border-border bg-surface-raised py-1 shadow-lg">
                {overflowTabIds.map((tabId) => {
                  const { label, Icon } = tabInfo(tabId);
                  return (
                    <div key={tabId} className="flex items-center text-muted hover:bg-surface-overlay">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:text-foreground"
                        onClick={(event) => {
                          setActiveTab(tabId);
                          setOverflowMenuOpen(false);
                          event.currentTarget.closest("details")?.removeAttribute("open");
                        }}
                      >
                        <Icon size={13} className="shrink-0" />
                        <span className="truncate">{label}</span>
                      </button>
                      <button
                        type="button"
                        title={`Close ${label}`}
                        aria-label={`Close ${label}`}
                        className="mr-1 flex size-6 shrink-0 items-center justify-center rounded hover:bg-surface-raised hover:text-foreground"
                        onClick={() => closeTab(tabId)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          <div ref={addMenuRef} className="relative shrink-0">
            <button
              ref={addButtonRef}
              type="button"
              title="New dock page"
              aria-label="New dock page"
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              className="flex size-7 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
              onClick={() => {
                setOverflowMenuOpen(false);
                setAddMenuOpen((open) => !open);
              }}
            >
              <Plus size={14} />
            </button>
            {addMenuOpen && (
              <div
                role="menu"
                className={`absolute top-8 z-[70] w-44 overflow-hidden rounded border border-border bg-surface-raised py-1 shadow-lg ${
                  tabOrder.length === 0 ? "left-0" : "right-0"
                }`}
                onKeyDown={(event) => {
                  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                    return;
                  }
                  const items = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      '[role="menuitem"]:not(:disabled)',
                    ),
                  );
                  if (items.length === 0) return;
                  event.preventDefault();
                  const current = items.indexOf(document.activeElement as HTMLButtonElement);
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : event.key === "ArrowDown"
                          ? (current + 1 + items.length) % items.length
                          : (current - 1 + items.length) % items.length;
                  items[next]?.focus();
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted hover:bg-surface-overlay hover:text-foreground"
                  onClick={createFiles}
                >
                  <FolderTree size={14} />
                  Files
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted hover:bg-surface-overlay hover:text-foreground"
                  onClick={createTree}
                >
                  <GitBranch size={14} />
                  Session tree
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={browserTabs.length >= MAX_BROWSER_TABS}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
                  onClick={createBrowser}
                >
                  <Globe2 size={14} />
                  Browser
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!workspaceCwd}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
                  onClick={createShell}
                >
                  <SquareTerminal size={14} />
                  Terminal
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {tabOrder.includes("files") && (
          <div
            role="tabpanel"
            id="dock-panel-files"
            aria-labelledby="dock-tab-files"
            className={`min-h-0 flex-1 ${activeTab === "files" ? "flex" : "hidden"}`}
          >
            <FilesPanel visible={activeTab === "files" && dockOpen} />
          </div>
        )}
        {tabOrder.includes("tree") && (
          <div
            role="tabpanel"
            id="dock-panel-tree"
            aria-labelledby="dock-tab-tree"
            className={`min-h-0 flex-1 ${activeTab === "tree" ? "flex" : "hidden"}`}
          >
            <TreePanel visible={activeTab === "tree" && dockOpen} />
          </div>
        )}
        {browserTabs.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            id={`dock-panel-${browserTabId(tab.id)}`}
            aria-labelledby={`dock-tab-${browserTabId(tab.id)}`}
            className={`min-h-0 flex-1 ${activeTab === browserTabId(tab.id) ? "flex" : "hidden"}`}
          >
            <BrowserPanel
              id={tab.id}
              visible={activeTab === browserTabId(tab.id) && dockOpen}
              blocked={addMenuOpen || overflowMenuOpen}
              onTitle={(title) =>
                setBrowserTabs((current) =>
                  current.map((candidate) =>
                    candidate.id === tab.id ? { ...candidate, title } : candidate,
                  ),
                )
              }
            />
          </div>
        ))}
        {shellTabs.map((tab) => (
          <ShellTerminal
            key={`${tab.id}:${tab.generation}`}
            cwd={tab.cwd}
            generation={tab.generation}
            visible={activeTab === shellTabId(tab.id)}
            profileId={tab.profileId}
            onWarning={(message) => pushNotification(message, "warning")}
            onStatus={(status) =>
              setShellTabs((current) =>
                current.map((candidate) =>
                  candidate.id === tab.id && candidate.generation === tab.generation
                    ? { ...candidate, status }
                    : candidate,
                ),
              )
            }
          />
        ))}
        {panel && (
          <ExtensionTerminal visible={activeTab === extensionTabId(panel.requestId)} />
        )}
        {tabOrder.length === 0 && (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <div className="flex w-56 flex-col items-center gap-4">
              <PiMark className="size-16" />
              <div className="flex w-full flex-col gap-1">
                <button
                  type="button"
                  aria-label="Open Files"
                  className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  onClick={createFiles}
                >
                  <FolderTree size={17} className="shrink-0" />
                  <span>Files</span>
                </button>
                <button
                  type="button"
                  aria-label="Open Session tree"
                  className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  onClick={createTree}
                >
                  <GitBranch size={17} className="shrink-0" />
                  <span>Session tree</span>
                </button>
                <button
                  type="button"
                  aria-label="Open Browser"
                  disabled={browserTabs.length >= MAX_BROWSER_TABS}
                  className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
                  onClick={createBrowser}
                >
                  <Globe2 size={17} className="shrink-0" />
                  <span>Browser</span>
                </button>
                <button
                  type="button"
                  aria-label="Open Terminal"
                  title={workspaceCwd ? "Open Terminal" : "Open a workspace to use Terminal"}
                  disabled={!workspaceCwd}
                  className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
                  onClick={createShell}
                >
                  <SquareTerminal size={17} className="shrink-0" />
                  <span>Terminal</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
