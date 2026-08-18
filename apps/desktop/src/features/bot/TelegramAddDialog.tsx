import { useEffect, useRef, useState } from "react";
import { Bot, LoaderCircle } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { useT } from "../../lib/i18n/use-t";
import {
  type BotGateway,
  createTelegramGateway,
  defaultGatewayWorkspacePath,
} from "./gateway-store";

export function TelegramAddDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: (gateway: BotGateway) => void;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);

  const [token, setToken] = useState("");
  const [alias, setAlias] = useState("");
  // Preview of the bot identity returned by getMe (auto-filled, read-only).
  // workspacePath is the host-provisioned default workspace dir for this gateway.
  const [preview, setPreview] = useState<{
    username: string | null;
    firstName: string | null;
    workspacePath: string | null;
  } | null>(null);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab" || !focusable().length) return;
      const items = focusable();
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  async function validate(): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) {
      setError(t("botAddTelegramTokenRequired"));
      return;
    }
    if (!host) {
      setError(t("notifHostUnavailable", { summary: "" }));
      return;
    }
    setValidating(true);
    setError(null);
    setPreview(null);
    try {
      const res = await hostClient.request(
        "telegram.validateToken",
        hostContext(host),
        { token: trimmed },
        20_000,
      );
      if (!res.ok) {
        setError(res.error.message || t("botAddTelegramValidateFailed"));
        return;
      }
      const result = res.result;
      if (!result.ok) {
        setError(result.description || t("botAddTelegramValidateFailed"));
        return;
      }
      const workspacePath = result.workspacePath ?? null;
      setPreview({
        username: result.username ?? null,
        firstName: result.firstName ?? null,
        workspacePath,
      });
      if (!alias) {
        setAlias(result.firstName ?? result.username ?? "");
      }
      if (!workspacePath) {
        // Token is valid but the host could not create the workspace dir — warn
        // but keep the preview so the user can still save the identity.
        setError(
          result.description || t("botAddTelegramWorkspaceNotCreated"),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("botAddTelegramValidateFailed"));
    } finally {
      setValidating(false);
    }
  }

  function submit() {
    const trimmed = token.trim();
    if (!trimmed) {
      setError(t("botAddTelegramTokenRequired"));
      return;
    }
    if (!preview) return;
    const gateway = createTelegramGateway({
      token: trimmed,
      username: preview.username,
      firstName: preview.firstName,
      botId: null,
      name: alias,
      boundWorkspacePath:
        preview.workspacePath ?? defaultGatewayWorkspacePath("telegram", host?.agentDir ?? ""),
    });
    onConfirm(gateway);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="telegram-add-dialog-title"
        className="theme-floating-surface w-full max-w-lg overflow-auto rounded-xl border border-border bg-surface-raised p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-md bg-accent/15 p-1.5 text-accent">
            <Bot size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="telegram-add-dialog-title" className="text-base font-semibold">
              {t("botAddTelegramTitle")}
            </h2>
            <p className="mt-1 text-xs text-muted">{t("botAddTelegramSubtitle")}</p>

            <form
              className="mt-4 flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">
                  {t("botAddTelegramTokenLabel")}
                </span>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      setPreview(null);
                      setError(null);
                    }}
                    placeholder={t("botAddTelegramTokenPlaceholder")}
                    className="h-9 flex-1 rounded-md border border-border bg-surface px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  />
                  <button
                    type="button"
                    onClick={() => void validate()}
                    disabled={!token.trim() || validating || !host}
                    className="interface-density-control inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {validating ? (
                      <LoaderCircle size={14} className="animate-spin" />
                    ) : (
                      <span>{t("botAddTelegramValidate")}</span>
                    )}
                  </button>
                </div>
              </label>

              {preview && (
                <div className="flex items-center gap-3 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm">
                  <Bot size={14} className="shrink-0 text-success" />
                  <div className="min-w-0">
                    <span className="block font-medium text-foreground">
                      {preview.username ? `@${preview.username}` : t("botAddTelegramUnknownBot")}
                    </span>
                    {(preview.firstName || preview.username) && (
                      <span className="block truncate text-xs text-muted">
                        {preview.firstName ?? t("botAddTelegramUnknownName")}
                      </span>
                    )}
                  </div>
                </div>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">
                  {t("botAddTelegramNameLabel")}
                </span>
                <input
                  type="text"
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                  placeholder={preview?.firstName ?? preview?.username ?? t("botAddTelegramNamePlaceholder")}
                  className="h-9 rounded-md border border-border bg-surface px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
                />
              </label>

              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">
                  {t("botAddTelegramWorkspaceLabel")}
                </span>
                <div className="flex h-9 items-center rounded-md border border-border bg-surface px-3 text-muted">
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {t("botAddTelegramWorkspaceDefault")}
                  </span>
                  {preview?.workspacePath && (
                    <span className="ml-2 shrink-0 text-[10px] text-success">
                      {t("botAddTelegramWorkspaceReady")}
                    </span>
                  )}
                </div>
              </div>

              {error && (
                <p role="status" className="text-xs text-danger">
                  {error}
                </p>
              )}

              <div className="mt-1 flex justify-end gap-2">
                <button
                  type="button"
                  className="interface-density-control inline-flex h-8 items-center justify-center rounded-md border border-border px-2.5 text-xs hover:bg-surface-overlay"
                  onClick={onCancel}
                >
                  {t("commonCancel")}
                </button>
                <button
                  type="submit"
                  className="interface-density-control inline-flex h-8 items-center justify-center rounded-md bg-accent px-2.5 text-xs text-accent-foreground hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!token.trim() || validating || !preview}
                >
                  {t("botAddTelegramConfirm")}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
