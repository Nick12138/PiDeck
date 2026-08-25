export type DockPreviewOpenRequest = {
  path: string;
};

type DockPreviewOpenHandler = (request: DockPreviewOpenRequest) => boolean;

const handlers = new Set<DockPreviewOpenHandler>();

/** Ask the right Dock to open (or switch) the preview tab for a workspace file. */
export function requestDockPreview(request: DockPreviewOpenRequest): boolean {
  for (const handler of handlers) {
    try {
      if (handler(request)) return true;
    } catch {
      // A broken or unmounted Dock must not break the caller.
    }
  }
  return false;
}

export function subscribeDockPreview(handler: DockPreviewOpenHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
