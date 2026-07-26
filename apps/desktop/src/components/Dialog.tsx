import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, PackageOpen } from "lucide-react";

export const secondaryButton =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded border border-border px-2.5 text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40";
export const primaryButton =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded bg-accent px-2.5 text-xs text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40";

export function Dialog({
  title,
  children,
  confirmLabel,
  destructive = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass inline handlers; route through a ref so the effect stays
  // mount-stable and parent re-renders cannot re-run the initial focus().
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    const dialog = ref.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      // A layer above this dialog (e.g. an extension modal) already acted on
      // the key; do not double-fire.
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        // Consume the event so outer Escape handlers (e.g. the Settings
        // overlay close) never see it: closing this dialog is the whole action.
        event.preventDefault();
        event.stopPropagation();
        return onCancelRef.current();
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return event.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        className="max-h-[min(680px,90vh)] w-full max-w-lg overflow-auto rounded-lg border border-border bg-surface-raised p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 rounded p-1.5 ${destructive ? "bg-warning/15 text-warning" : "bg-accent/15 text-accent"}`}>
            {destructive ? <AlertTriangle size={18} /> : <PackageOpen size={18} />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="app-dialog-title" className="text-base font-semibold">{title}</h2>
            <div className="mt-2 text-sm text-muted">{children}</div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className={destructive ? `${primaryButton} bg-warning text-black hover:bg-warning/80` : primaryButton}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
