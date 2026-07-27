import { useId } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { ExtensionUiRequestContent } from "./ExtensionUiRequestContent";
import { useExtensionUiResponse } from "./use-extension-ui-response";

export function InlineExtensionUiRequest() {
  const activeRequest = useAppStore((state) => state.extensionUiRequest);
  const request = activeRequest?.presentation === "inline" ? activeRequest : null;
  const controller = useExtensionUiResponse(request);
  const titleId = useId();

  if (!request) return null;
  return (
    <section
      role="region"
      aria-labelledby={titleId}
      className="shrink-0 px-5 pt-2"
      data-extension-ui-surface="inline"
    >
      <div
        className={`mx-auto max-h-[min(32rem,50dvh)] w-full max-w-3xl overflow-y-auto overscroll-contain rounded-md border bg-surface-raised px-3.5 py-3 shadow-sm ${
          request.risk === "high" ? "border-warning/40" : "border-border"
        }`}
      >
        <ExtensionUiRequestContent
          request={request}
          controller={controller}
          titleId={titleId}
          variant="inline"
        />
      </div>
    </section>
  );
}
