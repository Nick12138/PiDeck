import { tCurrent } from "./i18n/use-t";
import { useAppStore } from "./stores/app-store";
import {
  draftKeyForTarget,
  type DraftKey,
  type DraftMutation,
  type DraftTarget,
  type DraftWorkspaceSnapshot,
} from "./draft-target";

export const DRAFT_WRITE_DEBOUNCE_MS = 250;
const DRAFT_CLOSE_FLUSH_TIMEOUT_MS = 500;

export type DraftSendReceipt = {
  target: DraftTarget;
  text: string;
  version: number;
};

let pendingMutations = new Map<DraftKey, DraftMutation>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let persistenceFailureNotified = false;
let hydrationRequest = 0;

function mutationKey(mutation: DraftMutation): DraftKey {
  return draftKeyForTarget(mutation.target);
}

function notifyPersistenceFailure(error: unknown): void {
  if (persistenceFailureNotified) return;
  persistenceFailureNotified = true;
  const detail = error instanceof Error ? error.message : String(error);
  useAppStore
    .getState()
    .pushNotification(`${tCurrent("notifDraftPersistenceFailed")}: ${detail}`, "warning");
}

function queueMutation(mutation: DraftMutation): void {
  pendingMutations.set(mutationKey(mutation), mutation);
  if (writeTimer !== null) return;
  writeTimer = globalThis.setTimeout(() => {
    writeTimer = null;
    void flushDraftWrites();
  }, DRAFT_WRITE_DEBOUNCE_MS);
}

async function applyNativeMutations(mutations: DraftMutation[]): Promise<void> {
  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) return;
  await invoke("desktop_drafts_apply", { mutations });
}

function requeueFailedBatch(mutations: readonly DraftMutation[]): void {
  for (const mutation of mutations) {
    const key = mutationKey(mutation);
    if (!pendingMutations.has(key)) pendingMutations.set(key, mutation);
  }
}

export function flushDraftWrites(): Promise<void> {
  if (writeTimer !== null) {
    globalThis.clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (pendingMutations.size === 0) return writeQueue;

  const mutations = [...pendingMutations.values()];
  pendingMutations = new Map();
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(() => applyNativeMutations(mutations))
    .then(() => {
      persistenceFailureNotified = false;
    })
    .catch((error) => {
      requeueFailedBatch(mutations);
      notifyPersistenceFailure(error);
    });
  return writeQueue;
}

export async function settleDraftWritesWithin(
  timeoutMs = DRAFT_CLOSE_FLUSH_TIMEOUT_MS,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      flushDraftWrites(),
      new Promise<void>((resolve) => {
        timeout = globalThis.setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== null) globalThis.clearTimeout(timeout);
  }
}

export function editDraft(target: DraftTarget, text: string): number {
  const version = useAppStore.getState().setDraftTextLocal(target, text);
  queueMutation(text.trim() ? { op: "upsert", target, text } : { op: "delete", target });
  return version;
}

export function deleteDraft(target: DraftTarget): number {
  const version = useAppStore.getState().setDraftTextLocal(target, "");
  queueMutation({ op: "delete", target });
  return version;
}

export function deleteSessionDrafts(canonicalCwd: string, sessionIds: readonly string[]): void {
  for (const sessionId of new Set(sessionIds)) {
    deleteDraft({ kind: "session", canonicalCwd, sessionId });
  }
}

export function stageDraftSend(target: DraftTarget): DraftSendReceipt {
  const key = draftKeyForTarget(target);
  const state = useAppStore.getState();
  const text = state.draftTexts[key] ?? "";
  const version = state.setDraftTextLocal(target, "");
  return { target, text, version };
}

export function commitDraftSend(receipt: DraftSendReceipt): boolean {
  const key = draftKeyForTarget(receipt.target);
  if ((useAppStore.getState().draftEditVersions[key] ?? 0) !== receipt.version) return false;
  queueMutation({ op: "delete", target: receipt.target });
  return true;
}

export function restoreDraftSend(receipt: DraftSendReceipt): string {
  const key = draftKeyForTarget(receipt.target);
  const state = useAppStore.getState();
  const currentVersion = state.draftEditVersions[key] ?? 0;
  const currentText = state.draftTexts[key] ?? "";
  const restored =
    currentVersion === receipt.version || !currentText
      ? receipt.text
      : receipt.text
        ? `${receipt.text}\n\n${currentText}`
        : currentText;
  editDraft(receipt.target, restored);
  return restored;
}

export async function hydrateDraftWorkspace(canonicalCwd: string): Promise<void> {
  const request = ++hydrationRequest;
  const baselineVersions = { ...useAppStore.getState().draftEditVersions };
  try {
    const { invoke, isTauri } = await import("@tauri-apps/api/core");
    const snapshot = isTauri()
      ? await invoke<DraftWorkspaceSnapshot>("desktop_drafts_get", { canonicalCwd })
      : { schemaVersion: 1, drafts: [] };
    if (request !== hydrationRequest) return;
    const store = useAppStore.getState();
    store.mergeHydratedDrafts(canonicalCwd, snapshot.drafts, baselineVersions);
    if (snapshot.warning) {
      store.pushNotification(
        snapshot.recoveredFrom
          ? `${snapshot.warning}. Backup: ${snapshot.recoveredFrom}`
          : snapshot.warning,
        "warning",
      );
    }
  } catch (error) {
    if (request === hydrationRequest) notifyPersistenceFailure(error);
  }
}

export function __resetDraftPersistenceForTests(): void {
  if (writeTimer !== null) globalThis.clearTimeout(writeTimer);
  pendingMutations = new Map();
  writeTimer = null;
  writeQueue = Promise.resolve();
  persistenceFailureNotified = false;
  hydrationRequest = 0;
}
