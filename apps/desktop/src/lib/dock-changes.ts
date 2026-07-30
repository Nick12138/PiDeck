type ChangesPanelOpenHandler = () => boolean;

const handlers = new Set<ChangesPanelOpenHandler>();
let pending = false;

/** Ask the right dock to open (or focus) the singleton Changes panel. */
export function requestChangesPanel(): void {
  let consumed = false;
  for (const handler of handlers) consumed = handler() || consumed;
  if (!consumed) pending = true;
}

export function subscribeChangesPanel(handler: ChangesPanelOpenHandler): () => void {
  handlers.add(handler);
  if (pending && handler()) pending = false;
  return () => handlers.delete(handler);
}

export function clearPendingChangesPanelForTest(): void {
  pending = false;
}
