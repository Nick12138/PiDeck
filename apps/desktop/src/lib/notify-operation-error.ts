import { isHostEpochError } from "./bridge/host-client";
import { useAppStore } from "./stores/app-store";

/**
 * User-safe message for a thrown error: internal host-epoch rejection
 * reasons ("bootstrap hello", …) collapse to the localized fallback, real
 * errors keep their message.
 */
export function userErrorMessage(error: unknown, fallback: string): string {
  if (isHostEpochError(error)) return fallback;
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Push an error notification for a failed user action, using the thrown
 * error's message when available.
 *
 * Requests the Host aborts because its epoch ended (bootstrap recovery
 * races, transport swaps, watchdog restarts) reject with `HostEpochError`
 * whose message is an internal reason string ("bootstrap hello", …). The
 * recovery loop restores state on its own, so those rejections stay silent —
 * surfacing them would leak internals into the toast and the notification
 * history.
 *
 * Returns true when a notification was actually pushed.
 */
export function notifyOperationFailure(
  error: unknown,
  fallback: string,
  level: "error" | "warning" = "error",
): boolean {
  if (isHostEpochError(error)) {
    console.debug("[notify] suppressed host-epoch rejection:", error.message);
    return false;
  }
  const message = error instanceof Error && error.message ? error.message : fallback;
  useAppStore.getState().pushNotification(message, level);
  return true;
}
