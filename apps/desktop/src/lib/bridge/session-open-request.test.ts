import { describe, expect, it, vi } from "vitest";
import {
  LatestSessionOpenQueue,
  requestSessionOpenWithRetry,
  shouldRetrySessionOpen,
} from "./session-open-request";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("LatestSessionOpenQueue", () => {
  it("finishes the active switch and then opens only the latest queued conversation", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const calls: string[] = [];
    const running: boolean[] = [];
    const superseded: boolean[] = [];
    const queue = new LatestSessionOpenQueue(
      async (path, isSuperseded) => {
        calls.push(path);
        if (path === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
          superseded.push(isSuperseded());
        }
      },
      (value) => running.push(value),
      (error) => {
        throw error;
      },
    );

    queue.enqueue("first");
    await firstStarted.promise;
    queue.enqueue("middle");
    queue.enqueue("latest");
    releaseFirst.resolve();
    await queue.whenIdle();

    expect(calls).toEqual(["first", "latest"]);
    expect(superseded).toEqual([true]);
    expect(running).toEqual([true, false]);
    expect(queue.isRunning()).toBe(false);
  });

  it("continues with the latest choice after an unexpected runner failure", async () => {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const queue = new LatestSessionOpenQueue(
      async (path) => {
        calls.push(path);
        if (path === "broken") {
          firstStarted.resolve();
          await releaseFirst.promise;
          throw new Error("open failed");
        }
      },
      () => {},
      (error) => errors.push(error),
    );

    queue.enqueue("broken");
    await firstStarted.promise;
    queue.enqueue("recovery");
    releaseFirst.resolve();
    await queue.whenIdle();

    expect(calls).toEqual(["broken", "recovery"]);
    expect(errors).toHaveLength(1);
  });
});

describe("requestSessionOpenWithRetry", () => {
  it("retries transient service graph contention", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
      })
      .mockResolvedValueOnce({ ok: true as const });
    const wait = vi.fn(async () => {});

    await expect(requestSessionOpenWithRetry(request, wait)).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(80);
  });

  it("does not retry permanent failures", async () => {
    const response = {
      ok: false as const,
      error: { code: "SESSION_NOT_FOUND", retryable: false },
    };
    const request = vi.fn(async () => response);
    const wait = vi.fn(async () => {});

    await expect(requestSessionOpenWithRetry(request, wait)).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(shouldRetrySessionOpen(response.error)).toBe(false);
  });

  it("stops retrying when the request generation is no longer current", async () => {
    const request = vi.fn(async () => ({
      ok: false as const,
      error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
    }));
    let current = true;
    const wait = vi.fn(async () => {
      current = false;
    });

    await expect(
      requestSessionOpenWithRetry(request, wait, () => current),
    ).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds persistent graph contention", async () => {
    const response = {
      ok: false as const,
      error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
    };
    const request = vi.fn(async () => response);
    const wait = vi.fn(async () => {});

    await expect(requestSessionOpenWithRetry(request, wait)).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(6);
    expect(wait.mock.calls).toEqual([[80], [160], [240], [400], [600]]);
  });
});
