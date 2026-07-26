import { useAppStore } from "./stores/app-store";
import { hostClient } from "./bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
  mergeHostIdentity,
} from "./bridge/host-context";
import { SESSION_OPEN_TIMEOUT_MS } from "./bridge/session-open-request";
import { requestWithRetry } from "./bridge/request-retry";

/**
 * Fork the active session before the given user message and switch to the
 * forked session. Returns true when the fork was applied.
 */
export async function requestFork(entryId: string): Promise<boolean> {
  const {
    host,
    workspace,
    session,
    pushNotification,
    applySessionSnapshot,
    setSessionDraft,
  } = useAppStore.getState();
  if (!host || !workspace || !session) return false;
  if (!session.isIdle) {
    pushNotification("Wait for the agent to finish before forking", "info");
    return false;
  }
  const generation = captureRequestGeneration(host);
  try {
    // Fork ends in the session-open flow, so it shares its generous timeout.
    const res = await requestWithRetry(() =>
      hostClient.request(
        "session.fork",
        activeSessionContext(host, workspace, session),
        { entryId },
        SESSION_OPEN_TIMEOUT_MS,
      ),
    );
    if (!res) return false;
    if (
      !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      })
    ) {
      return false;
    }
    if (!res.ok) {
      pushNotification(res.error?.message ?? "Fork failed", "error");
      return false;
    }
    applySessionSnapshot(res.result.session);
    const latestHost = useAppStore.getState().host;
    if (latestHost) {
      const nextHost = mergeHostIdentity(latestHost, res);
      if (nextHost) useAppStore.getState().setHost(nextHost);
    }
    if (res.result.selectedText !== undefined) {
      setSessionDraft(res.result.session.sessionId, res.result.selectedText);
    }
    pushNotification("Forked into a new session", "info");
    return true;
  } catch (error) {
    pushNotification(error instanceof Error ? error.message : "Fork failed", "error");
    return false;
  }
}
