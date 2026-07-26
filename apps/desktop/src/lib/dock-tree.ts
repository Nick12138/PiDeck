type TreePanelOpenHandler = () => boolean;

const handlers = new Set<TreePanelOpenHandler>();
let pending = false;

/** Ask the dock to open (or focus) the session tree panel. */
export function requestTreePanel(): void {
  let consumed = false;
  for (const handler of handlers) consumed = handler() || consumed;
  if (!consumed) pending = true;
}

export function subscribeTreePanel(handler: TreePanelOpenHandler): () => void {
  handlers.add(handler);
  if (pending && handler()) pending = false;
  return () => handlers.delete(handler);
}

export function clearPendingTreePanelForTest(): void {
  pending = false;
}
