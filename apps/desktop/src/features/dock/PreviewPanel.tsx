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

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type PreviewStatus = "idle" | "loading" | "ready" | "error";

export function PreviewPanel({ path, visible }: { path: string | null; visible: boolean }) {
  const t = useT();
  const workspace = useAppStore((state) => state.workspace);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

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
      } catch (readError) {
        if (id !== generation.current) return;
        setStatus("error");
        setError(readError instanceof Error ? readError.message : t("dockPreviewReadFailed"));
      }
    },
    [t],
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
      className="preview-panel flex min-h-0 flex-1 flex-col bg-surface"
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
          <div className="min-h-0 flex-1 overflow-auto">
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
        </>
      )}
    </section>
  );
}
