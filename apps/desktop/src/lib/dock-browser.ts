export type DockBrowserOpenRequest = {
  url: string;
};

type DockBrowserOpenHandler = (request: DockBrowserOpenRequest) => boolean;

const handlers = new Set<DockBrowserOpenHandler>();

function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isSafeBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/** Ask the right Dock to create and activate a browser tab for a safe web URL. */
export function requestDockBrowser(request: DockBrowserOpenRequest): boolean {
  if (!isDesktopRuntime() || !isSafeBrowserUrl(request.url)) return false;
  for (const handler of handlers) {
    try {
      if (handler(request)) return true;
    } catch {
      // A broken or unmounted Dock must not prevent the system-browser fallback.
    }
  }
  return false;
}

export function subscribeDockBrowser(handler: DockBrowserOpenHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
