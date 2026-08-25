import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, FileQuestion, LoaderCircle, RefreshCw } from "lucide-react";
import { Streamdown } from "streamdown";
import { DEFAULT_PREVIEW_MAX_BYTES, type WorkspaceFilePreview } from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import { workspaceContext } from "../../lib/bridge/host-context";
import { subscribeValidatedHostEvent } from "../../lib/bridge/validated-host-events";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { workspaceAbsolutePath } from "./FilesPanel";

const MARKDOWN_PATTERN = /\.(?:md|markdown|mdx)$/i;
/** Horizontal scrollers rendered inside markdown (wide tables and code blocks). */
const H_SCROLL_SELECTOR =
  '[data-streamdown="table-wrapper"] > div, [data-streamdown="code-block"]';

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type PreviewStatus = "idle" | "loading" | "ready" | "error";

type ThumbState = { visible: boolean; ratio: number; offset: number };

const HIDDEN_THUMB: ThumbState = { visible: false, ratio: 0, offset: 0 };

type ScrollDrag = {
  axis: "v" | "h";
  pointerId: number;
  startClient: number;
  startScroll: number;
};

/** The Windows build runs in a transparent WebView (acrylic), where WebView2
 *  renders no native scrollbars at all. The preview therefore draws its own
 *  always-visible sliders for the outer vertical scroller and for any wide
 *  table/code scroller inside the markdown content. */
export function PreviewPanel({ path, visible }: { path: string | null; visible: boolean }) {
  const t = useT();
  const workspace = useAppStore((state) => state.workspace);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hTargetRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<ScrollDrag | null>(null);
  const [vThumb, setVThumb] = useState<ThumbState>(HIDDEN_THUMB);
  const [hThumb, setHThumb] = useState<ThumbState>(HIDDEN_THUMB);

  const updateThumbs = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxV = el.scrollHeight - el.clientHeight;
    setVThumb({
      visible: maxV > 1,
      ratio: el.clientHeight / el.scrollHeight,
      offset: maxV > 0 ? el.scrollTop / maxV : 0,
    });
    let hTarget: HTMLElement | null = null;
    for (const candidate of el.querySelectorAll<HTMLElement>(H_SCROLL_SELECTOR)) {
      if (candidate.scrollWidth > candidate.clientWidth + 1) {
        hTarget = candidate;
        break;
      }
    }
    hTargetRef.current = hTarget;
    if (!hTarget) {
      setHThumb(HIDDEN_THUMB);
      return;
    }
    const maxH = hTarget.scrollWidth - hTarget.clientWidth;
    setHThumb({
      visible: maxH > 1,
      ratio: hTarget.clientWidth / hTarget.scrollWidth,
      offset: maxH > 0 ? hTarget.scrollLeft / maxH : 0,
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Recompute whenever the content or layout changes. scroll does not
    // bubble, so capture the outer scroller plus any scroll happening inside
    // Streamdown's table/code scrollers; MutationObserver catches late async
    // markdown renders, ResizeObserver catches tab show/hide size changes.
    updateThumbs();
    el.addEventListener("scroll", updateThumbs, { capture: true, passive: true });
    const observer = new MutationObserver(() => updateThumbs());
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(() => updateThumbs());
      resizeObserver.observe(el);
      return () => {
        el.removeEventListener("scroll", updateThumbs, true);
        observer.disconnect();
        resizeObserver.disconnect();
      };
    }
    return () => {
      el.removeEventListener("scroll", updateThumbs, true);
      observer.disconnect();
    };
  }, [updateThumbs, status, path]);

  const onTrackPointerDown = (axis: "v" | "h", event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    if (axis === "v") {
      if (vThumb.ratio >= 1) return;
      const rect = el.getBoundingClientRect();
      const thumbPx = Math.max(vThumb.ratio * rect.height, 28);
      const ratio = (event.clientY - rect.top - thumbPx / 2) / rect.height;
      el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
    } else {
      const target = hTargetRef.current;
      if (!target || hThumb.ratio >= 1) return;
      const rect = target.getBoundingClientRect();
      const thumbPx = Math.max(hThumb.ratio * rect.width, 28);
      const ratio = (event.clientX - rect.left - thumbPx / 2) / rect.width;
      target.scrollLeft = ratio * (target.scrollWidth - target.clientWidth);
    }
  };

  const onThumbPointerDown = (axis: "v" | "h", event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const el = scrollRef.current;
    if (!el) return;
    const target = axis === "v" ? el : hTargetRef.current;
    if (!target) return;
    dragRef.current = {
      axis,
      pointerId: event.pointerId,
      startClient: axis === "v" ? event.clientY : event.clientX,
      startScroll: axis === "v" ? target.scrollTop : target.scrollLeft,
    };
    el.setPointerCapture(event.pointerId);
  };

  const onScrollPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const el = scrollRef.current;
    if (!el) return;
    const target = drag.axis === "v" ? el : hTargetRef.current;
    if (!target) return;
    const delta = (drag.axis === "v" ? event.clientY : event.clientX) - drag.startClient;
    const ratio =
      drag.axis === "v"
        ? el.clientHeight / el.scrollHeight
        : target.clientWidth / target.scrollWidth;
    if (drag.axis === "v") {
      target.scrollTop = drag.startScroll + delta / ratio;
    } else {
      target.scrollLeft = drag.startScroll + delta / ratio;
    }
  };

  const endScrollDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    scrollRef.current?.releasePointerCapture(event.pointerId);
  };

  const load = useCallback(
    async (target: string) => {
      const state = useAppStore.getState();
      if (!state.host || !state.workspace) {
        setStatus("error");
        setError(t("dockNoWorkspace"));
        return;
      }
      const id = ++generation.current;
      setStatus("loading");
      setPreview(null);
      setError(null);
      try {
        const response = await hostClient.request(
          "workspace.readFile",
          workspaceContext(state.host, state.workspace),
          { path: target, maxBytes: DEFAULT_PREVIEW_MAX_BYTES },
        );
        if (id !== generation.current) return;
        if (!response.ok) {
          setStatus("error");
          setError(localizeHostError(response.error, t));
          return;
        }
        setPreview(response.result);
        setStatus("ready");
        setVThumb(HIDDEN_THUMB);
        setHThumb(HIDDEN_THUMB);
        // Give React (and Streamdown's internal state) a few frames to commit
        // the rendered content before measuring scroll geometry.
        for (const delay of [0, 50, 200]) {
          window.setTimeout(updateThumbs, delay);
        }
      } catch (readError) {
        if (id !== generation.current) return;
        setStatus("error");
        setError(readError instanceof Error ? readError.message : t("dockPreviewReadFailed"));
      }
    },
    [t, updateThumbs],
  );

  useEffect(() => {
    if (!path) {
      generation.current += 1;
      setPreview(null);
      setStatus("idle");
      setError(null);
      return;
    }
    void load(path);
  }, [path, load]);

  useEffect(() => {
    if (!path || !visible) return;
    const current = useAppStore.getState();
    if (!current.host || !current.workspace) return;
    const context = workspaceContext(current.host, current.workspace);
    return subscribeValidatedHostEvent("workspace.filesChanged", context, (event) => {
      if (!visible || !path) return;
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (
        event.payload.directories.includes("") ||
        event.payload.directories.includes(parent)
      ) {
        void load(path);
      }
    });
  }, [path, visible, load]);

  const openExternal = async () => {
    if (!workspace || !path) return;
    const absolute = workspaceAbsolutePath(workspace.canonicalCwd, path);
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(absolute);
    } catch {
      pushNotification(t("dockPreviewOpenExternalFailed"), "warning");
    }
  };

  const isMarkdown = path ? MARKDOWN_PATTERN.test(path) : false;
  const name = path ? basename(path) : "";
  const meta = preview
    ? `${formatSize(preview.size)}${preview.encoding ? ` · ${preview.encoding}` : ""}`
    : "";

  return (
    <section
      className="preview-panel relative flex min-h-0 flex-1 flex-col bg-surface"
      aria-label={t("dockPreviewRegion")}
      data-dock-panel
    >
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-xs" title={path ?? undefined}>
          {name}
        </span>
        {preview && <span className="shrink-0 text-[10px] text-muted">{meta}</span>}
        {status === "ready" && preview?.kind !== "binary" && (
          <button
            type="button"
            title={t("dockPreviewRefresh")}
            aria-label={t("dockPreviewRefresh")}
            className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
            onClick={() => path && void load(path)}
          >
            <RefreshCw size={14} />
          </button>
        )}
        {status === "ready" && preview && (
          <button
            type="button"
            title={t("dockPreviewOpenExternal")}
            aria-label={t("dockPreviewOpenExternal")}
            className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
            onClick={() => void openExternal()}
          >
            <ExternalLink size={14} />
          </button>
        )}
      </div>

      {status === "loading" && (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted">
          <LoaderCircle size={16} className="animate-spin" />
        </div>
      )}

      {status === "error" && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertTriangle size={22} className="text-muted" />
          <p className="max-w-full break-words text-xs text-muted">{error}</p>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-surface-overlay"
            onClick={() => path && void load(path)}
          >
            {t("dockRetry")}
          </button>
        </div>
      )}

      {status === "ready" && preview && (
        <>
          {preview.truncated && preview.kind !== "image" && (
            <div className="shrink-0 border-b border-border bg-surface-raised/60 px-3 py-1.5 text-[10px] text-muted">
              {t("dockPreviewTruncated", { size: formatSize(DEFAULT_PREVIEW_MAX_BYTES) })}
            </div>
          )}
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-auto"
            data-preview-scroll
            onPointerMove={onScrollPointerMove}
            onPointerUp={endScrollDrag}
            onPointerCancel={endScrollDrag}
          >
            {preview.kind === "image" ? (
              <div className="flex min-h-full items-center justify-center p-3">
                <img
                  alt={name}
                  src={`data:${preview.mimeType ?? "image/png"};base64,${preview.content ?? ""}`}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            ) : preview.kind === "binary" ? (
              <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <FileQuestion size={28} className="text-muted" />
                <p className="text-xs text-muted">{t("dockPreviewBinary")}</p>
                <p className="text-[10px] text-muted/70">{formatSize(preview.size)}</p>
                <button
                  type="button"
                  className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-surface-overlay"
                  onClick={() => void openExternal()}
                >
                  {t("dockPreviewOpenExternal")}
                </button>
              </div>
            ) : isMarkdown ? (
              <div className="preview-markdown chat-markdown px-4 py-3">
                <Streamdown mode="static">{preview.content ?? ""}</Streamdown>
              </div>
            ) : (
              <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-foreground/90">
                {preview.content ?? ""}
              </pre>
            )}
          </div>
          {vThumb.visible && (
            <div
              role="scrollbar"
              aria-orientation="vertical"
              aria-label={t("dockPreviewVerticalScroll")}
              title={t("dockPreviewVerticalScroll")}
              className="absolute bottom-2 right-1 top-10 w-2.5 cursor-pointer touch-none rounded-full bg-surface-overlay/50 hover:bg-surface-overlay"
              onPointerDown={(event) => onTrackPointerDown("v", event)}
            >
              <div
                className="absolute right-0.5 w-1.5 rounded-full bg-border-strong hover:bg-muted"
                style={{
                  top: `${vThumb.offset * 100}%`,
                  height: `${Math.max(vThumb.ratio * 100, 6)}%`,
                }}
                onPointerDown={(event) => onThumbPointerDown("v", event)}
              />
            </div>
          )}
          {hThumb.visible && (
            <div
              role="scrollbar"
              aria-orientation="horizontal"
              aria-label={t("dockPreviewHorizontalScroll")}
              title={t("dockPreviewHorizontalScroll")}
              className="absolute bottom-1 left-2 right-2 h-2.5 cursor-pointer touch-none rounded-full bg-surface-overlay/50 hover:bg-surface-overlay"
              onPointerDown={(event) => onTrackPointerDown("h", event)}
            >
              <div
                className="absolute bottom-0.5 h-1.5 rounded-full bg-border-strong hover:bg-muted"
                style={{
                  left: `${hThumb.offset * 100}%`,
                  width: `${Math.max(hThumb.ratio * 100, 6)}%`,
                }}
                onPointerDown={(event) => onThumbPointerDown("h", event)}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
