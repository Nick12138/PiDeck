import { describe, expect, it, vi } from "vitest";
import { TryMutex } from "./locks.js";

describe("TryMutex async acquisition", () => {
  it("transfers ownership to a waiter when the current owner releases", async () => {
    const lock = new TryMutex();
    expect(
      lock.tryAcquire({ operationKind: "package.mutation", requestId: "package-request" }),
    ).toBe(true);

    const waiting = lock.acquire(
      { operationKind: "system.shutdown", requestId: "shutdown-request" },
      100,
    );
    expect(lock.getOwner()?.requestId).toBe("package-request");

    lock.release("package-request");

    await expect(waiting).resolves.toBe(true);
    expect(lock.getOwner()).toMatchObject({
      operationKind: "system.shutdown",
      requestId: "shutdown-request",
    });
  });

  it("times out without stealing or later acquiring the lock", async () => {
    vi.useFakeTimers();
    try {
      const lock = new TryMutex();
      lock.tryAcquire({ operationKind: "package.mutation", requestId: "package-request" });
      const waiting = lock.acquire(
        { operationKind: "system.shutdown", requestId: "shutdown-request" },
        50,
      );

      await vi.advanceTimersByTimeAsync(50);
      await expect(waiting).resolves.toBe(false);
      lock.release("package-request");

      expect(lock.getOwner()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wake a waiter for a wrong-owner release", async () => {
    const lock = new TryMutex();
    lock.tryAcquire({ operationKind: "package.mutation", requestId: "package-request" });
    const waiting = lock.acquire(
      { operationKind: "system.shutdown", requestId: "shutdown-request" },
      100,
    );

    lock.release("different-request");
    expect(lock.getOwner()?.requestId).toBe("package-request");
    lock.release("package-request");

    await expect(waiting).resolves.toBe(true);
  });
});
