type RetryableResponse =
  | { ok: true }
  | { ok: false; error?: { retryable?: boolean } };

export const REQUEST_RETRY_DELAYS_MS = [80, 160, 240, 320] as const;

/**
 * Retry a Host request while it fails with a retryable error — typically a
 * transient SERVICE_GRAPH_BUSY collision between a read and a mutation.
 * Returns null when shouldContinue() reports the caller no longer wants the
 * result.
 */
export async function requestWithRetry<T extends RetryableResponse>(
  request: () => Promise<T>,
  wait: (delayMs: number) => Promise<unknown> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
  shouldContinue: () => boolean = () => true,
): Promise<T | null> {
  for (let attempt = 0; ; attempt += 1) {
    if (!shouldContinue()) return null;
    const response = await request();
    if (
      response.ok ||
      response.error?.retryable !== true ||
      attempt === REQUEST_RETRY_DELAYS_MS.length
    ) {
      return response;
    }
    await wait(REQUEST_RETRY_DELAYS_MS[attempt]!);
  }
}
