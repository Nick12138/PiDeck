type RetryableSessionOpenResponse =
  | { ok: true }
  | { ok: false; error: { code?: string; retryable?: boolean } };

const SESSION_OPEN_RETRY_DELAYS_MS = [80, 160, 240, 400, 600] as const;

// Opening can re-run extension session_start hooks, whose blocking UI timeout is
// 120 seconds. Keep the client alive long enough for the Host mutation to settle.
export const SESSION_OPEN_TIMEOUT_MS = 180_000;

type QueuedSessionOpen = {
  path: string;
  revision: number;
};

/** Serializes Host mutations while retaining the user's latest conversation choice. */
export class LatestSessionOpenQueue {
  private queued: QueuedSessionOpen | undefined;
  private running = false;
  private revision = 0;
  private idleWaiters = new Set<() => void>();

  constructor(
    private readonly run: (
      path: string,
      isSuperseded: () => boolean,
    ) => Promise<void>,
    private readonly onRunningChange: (running: boolean) => void,
    private readonly onUnexpectedError: (error: unknown) => void,
  ) {}

  enqueue(path: string): void {
    this.queued = { path, revision: ++this.revision };
    if (!this.running) void this.drain();
  }

  clearPending(): void {
    this.queued = undefined;
    this.revision += 1;
    this.resolveIdleWaiters();
  }

  isRunning(): boolean {
    return this.running;
  }

  whenIdle(): Promise<void> {
    if (!this.running && !this.queued) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private async drain(): Promise<void> {
    this.running = true;
    this.onRunningChange(true);
    try {
      while (this.queued) {
        const current = this.queued;
        this.queued = undefined;
        try {
          await this.run(current.path, () => current.revision !== this.revision);
        } catch (error) {
          this.onUnexpectedError(error);
        }
      }
    } finally {
      this.running = false;
      this.onRunningChange(false);
      if (this.queued) void this.drain();
      else this.resolveIdleWaiters();
    }
  }

  private resolveIdleWaiters(): void {
    if (this.running || this.queued) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

export function shouldRetrySessionOpen(error: {
  code?: string;
  retryable?: boolean;
}): boolean {
  return error.code === "SERVICE_GRAPH_BUSY" && error.retryable === true;
}

export async function requestSessionOpenWithRetry<T extends RetryableSessionOpenResponse>(
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
      !shouldRetrySessionOpen(response.error) ||
      attempt === SESSION_OPEN_RETRY_DELAYS_MS.length
    ) {
      return response;
    }
    await wait(SESSION_OPEN_RETRY_DELAYS_MS[attempt]!);
  }
}
