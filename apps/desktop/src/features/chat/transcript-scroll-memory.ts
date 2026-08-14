/**
 * In-memory per-session reading positions.
 *
 * A reader who scrolled into history keeps their place when they switch
 * sessions and come back; sessions left pinned to the tail reopen at the
 * bottom as before. Positions are process-local by design — restoring an
 * exact pixel offset is only meaningful while row layout is unchanged.
 */

export type TranscriptScrollPosition = {
  /** Rows hidden above the mounted window at save time. */
  hidden: number;
  scrollTop: number;
};

const positions = new Map<string, TranscriptScrollPosition>();

export function saveTranscriptScrollPosition(
  sessionId: string,
  position: TranscriptScrollPosition,
): void {
  positions.set(sessionId, position);
}

export function readTranscriptScrollPosition(
  sessionId: string,
): TranscriptScrollPosition | undefined {
  return positions.get(sessionId);
}

/** A session that leaves while pinned to the tail should reopen at the tail. */
export function forgetTranscriptScrollPosition(sessionId: string): void {
  positions.delete(sessionId);
}

/** Test isolation helper. */
export function clearTranscriptScrollPositions(): void {
  positions.clear();
}
