type ComposerInsertHandler = (text: string) => boolean;

const handlers = new Set<ComposerInsertHandler>();
let pending: string[] = [];

export function requestComposerInsert(text: string): void {
  const value = text.trim();
  if (!value) return;
  let consumed = false;
  for (const handler of handlers) consumed = handler(value) || consumed;
  if (!consumed) pending.push(value);
}

export function subscribeComposerInsert(handler: ComposerInsertHandler): () => void {
  handlers.add(handler);
  if (pending.length > 0) {
    pending = pending.filter((text) => !handler(text));
  }
  return () => handlers.delete(handler);
}

export function clearPendingComposerInsertsForTest(): void {
  pending = [];
}
