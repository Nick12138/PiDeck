import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useT } from "../../lib/i18n/use-t";
import { openSystemUrl } from "../../lib/open-system-url";
import { useAppStore } from "../../lib/stores/app-store";

type BrowserBounds = { x: number; y: number; width: number; height: number };
type BrowserSurfaceSnapshot = { surfaceId: string; url: string };
type BrowserSurfaceEvent = {
  surfaceId: string;
  kind: "load" | "title";
  url?: string;
  title?: string;
  loading?: boolean;
};

export function normalizeBrowserInput(input: string): string {
  const value = input.trim();
  if (!value) return "about:blank";
  if (/^https?:\/\//i.test(value) || value === "about:blank") return value;
  const localHost =
    value === "localhost" ||
    value.startsWith("localhost:") ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(value);
  const looksLikeHost =
    !/\s/.test(value) &&
    (localHost || value.includes("."));
  if (looksLikeHost) return `${localHost ? "http" : "https"}://${value}`;
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function elementBounds(element: HTMLElement | null): BrowserBounds | null {
  const rect = element?.getBoundingClientRect();
  if (!rect || rect.width < 1 || rect.height < 1) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function BrowserPanel({
  id,
  initialUrl = "about:blank",
  visible,
  blocked,
  onTitle,
}: {
  id: number;
  initialUrl?: string;
  visible: boolean;
  blocked: boolean;
  onTitle: (title: string) => void;
}) {
  const t = useT();
  const surfaceId = `dock-browser-${id}`;
  const pushNotification = useAppStore((state) => state.pushNotification);
  const bodyRef = useRef<HTMLDivElement>(null);
  const createdRef = useRef(false);
  const creatingRef = useRef(false);
  const activeRef = useRef(true);
  const closeTimerRef = useRef<number | null>(null);
  const onTitleRef = useRef(onTitle);
  const lastBoundsRef = useRef("");
  const [created, setCreated] = useState(false);
  const [address, setAddress] = useState(initialUrl === "about:blank" ? "" : initialUrl);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nativeVisible = visible && !blocked;
  onTitleRef.current = onTitle;

  useEffect(() => {
    activeRef.current = true;
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    return () => {
      closeTimerRef.current = window.setTimeout(() => {
        activeRef.current = false;
        if (createdRef.current) {
          void invoke("browser_surface_close", { surfaceId }).catch(() => undefined);
          createdRef.current = false;
        }
      }, 0);
    };
  }, [surfaceId]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<BrowserSurfaceEvent>("browser-surface-event", (event) => {
      const payload = event.payload;
      if (payload.surfaceId !== surfaceId) return;
      if (payload.kind === "load") {
        if (typeof payload.loading === "boolean") setLoading(payload.loading);
        if (payload.url) {
          setCurrentUrl(payload.url);
          setAddress(payload.url === "about:blank" ? "" : payload.url);
        }
      }
      if (payload.kind === "title" && payload.title?.trim()) {
        onTitleRef.current(payload.title.trim());
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [surfaceId]);

  const ensureSurface = useCallback(async () => {
    if (createdRef.current || creatingRef.current || !visible) return;
    if (!isTauriRuntime()) {
      setError("Native browser surfaces are available in the desktop app");
      return;
    }
    const bounds = elementBounds(bodyRef.current);
    if (!bounds) return;
    creatingRef.current = true;
    try {
      const snapshot = await invoke<BrowserSurfaceSnapshot>("browser_surface_create", {
        surfaceId,
        url: currentUrl,
        bounds,
        visible: nativeVisible,
      });
      if (!activeRef.current) {
        await invoke("browser_surface_close", { surfaceId }).catch(() => undefined);
        return;
      }
      createdRef.current = true;
      setCreated(true);
      setCurrentUrl(snapshot.url);
      setAddress(snapshot.url === "about:blank" ? "" : snapshot.url);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      creatingRef.current = false;
    }
  }, [surfaceId, currentUrl, nativeVisible, visible]);

  const syncBounds = useCallback(() => {
    const bounds = elementBounds(bodyRef.current);
    if (!bounds) return;
    if (!createdRef.current) {
      void ensureSurface();
      return;
    }
    const key = [bounds.x, bounds.y, bounds.width, bounds.height]
      .map((value) => Math.round(value * 10) / 10)
      .join(":");
    if (key === lastBoundsRef.current) return;
    lastBoundsRef.current = key;
    void invoke("browser_surface_set_bounds", { surfaceId, bounds }).catch(() => undefined);
  }, [ensureSurface, surfaceId]);

  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const observer = new ResizeObserver(syncBounds);
    observer.observe(element);
    window.addEventListener("resize", syncBounds);
    let frame = 0;
    let frameId = 0;
    const alignDuringDockMotion = () => {
      syncBounds();
      frame += 1;
      if (visible && frame < 20) frameId = window.requestAnimationFrame(alignDuringDockMotion);
    };
    frameId = window.requestAnimationFrame(alignDuringDockMotion);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.cancelAnimationFrame(frameId);
    };
  }, [visible, syncBounds]);

  useEffect(() => {
    if (!created) return;
    void invoke("browser_surface_set_visible", {
      surfaceId,
      visible: nativeVisible,
    }).catch(() => undefined);
    if (nativeVisible) syncBounds();
  }, [created, nativeVisible, surfaceId, syncBounds]);

  const navigate = async () => {
    if (!createdRef.current) {
      await ensureSurface();
      if (!createdRef.current) return;
    }
    const url = normalizeBrowserInput(address);
    setLoading(true);
    try {
      const normalized = await invoke<string>("browser_surface_navigate", {
        surfaceId,
        url,
      });
      setCurrentUrl(normalized);
      setAddress(normalized === "about:blank" ? "" : normalized);
      setError(null);
    } catch (cause) {
      setLoading(false);
      pushNotification(cause instanceof Error ? cause.message : String(cause), "warning");
    }
  };

  const control = (action: "back" | "forward" | "reload" | "stop") => {
    if (!createdRef.current) return;
    if (action === "reload") setLoading(true);
    void invoke("browser_surface_control", { surfaceId, action }).catch((cause) => {
      pushNotification(cause instanceof Error ? cause.message : String(cause), "warning");
    });
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-surface" aria-label="Browser">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <button
          type="button"
          title="Back"
          aria-label="Back"
          className="flex size-7 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-35"
          disabled={!created || currentUrl === "about:blank"}
          onClick={() => control("back")}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          title="Forward"
          aria-label="Forward"
          className="flex size-7 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-35"
          disabled={!created || currentUrl === "about:blank"}
          onClick={() => control("forward")}
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          title={loading ? "Stop loading" : "Reload"}
          aria-label={loading ? "Stop loading" : "Reload"}
          className="flex size-7 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-35"
          disabled={!created || currentUrl === "about:blank"}
          onClick={() => control(loading ? "stop" : "reload")}
        >
          {loading ? <X size={14} /> : <RefreshCw size={14} />}
        </button>
        <form
          className="relative min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate();
          }}
        >
          {loading ? (
            <LoaderCircle
              size={13}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 animate-spin text-muted"
            />
          ) : currentUrl === "about:blank" ? (
            <Search
              size={13}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
            />
          ) : (
            <Globe2
              size={13}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
            />
          )}
          <input
            type="text"
            aria-label="Browser address"
            value={address}
            placeholder="Search or enter address"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-7 w-full rounded border border-border bg-surface-raised pl-7 pr-2 text-xs outline-none focus:border-accent"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setAddress(event.target.value)}
          />
        </form>
      </div>
      <div ref={bodyRef} className="relative min-h-0 flex-1 bg-white">
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface px-6 text-center text-xs text-muted">
            <Globe2 size={20} />
            <span>{error}</span>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-foreground hover:bg-surface-overlay"
                onClick={() => {
                  setError(null);
                  void ensureSurface();
                }}
              >
                {t("browserRetry")}
              </button>
              {currentUrl !== "about:blank" && (
                <button
                  type="button"
                  className="flex items-center gap-1 rounded border border-border px-2 py-1 text-foreground hover:bg-surface-overlay"
                  onClick={() => void openSystemUrl(currentUrl)}
                >
                  <ExternalLink size={12} aria-hidden="true" />
                  {t("browserOpenSystem")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
