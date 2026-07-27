import { useEffect, useId, useRef } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { ExtensionUiRequestContent } from "./ExtensionUiRequestContent";
import { useExtensionUiResponse } from "./use-extension-ui-response";

export function ExtensionUiModal() {
  const activeRequest = useAppStore((state) => state.extensionUiRequest);
  const request = activeRequest?.presentation === "inline" ? null : activeRequest;
  const controller = useExtensionUiResponse(request);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!request) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>("button, textarea, input, select, [tabindex]:not([tabindex='-1'])")
        ?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      previousFocus?.focus();
    };
  }, [request?.requestId]);

  if (!request) return null;

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      void controller.respond("cancelled");
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
      "button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleDialogKeyDown}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface-raised p-5 shadow-xl"
        data-extension-ui-surface="modal"
      >
        <ExtensionUiRequestContent
          request={request}
          controller={controller}
          titleId={titleId}
          variant="modal"
        />
      </div>
    </div>
  );
}
