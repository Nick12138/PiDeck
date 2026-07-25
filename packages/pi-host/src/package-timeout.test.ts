import { describe, expect, it, vi } from "vitest";
import {
  PACKAGE_MUTATION_TIMEOUT_MS,
  waitForPackageMutation,
} from "./package-controller.js";

describe("package mutation timeout", () => {
  it("matches the desktop's ten minute package-operation budget", () => {
    expect(PACKAGE_MUTATION_TIMEOUT_MS).toBe(600_000);
  });

  it("returns a completed operation before the deadline", async () => {
    await expect(waitForPackageMutation(Promise.resolve("done"), 100)).resolves.toEqual({
      timedOut: false,
      value: "done",
    });
  });

  it("propagates an operation failure before the deadline", async () => {
    const failure = new Error("install failed");

    await expect(waitForPackageMutation(Promise.reject(failure), 100)).rejects.toBe(failure);
  });

  it("requests cancellation at the deadline and waits for operation completion", async () => {
    vi.useFakeTimers();
    try {
      let complete!: (value: string) => void;
      const operation = new Promise<string>((resolve) => {
        complete = resolve;
      });
      const cancel = vi.fn();
      const result = waitForPackageMutation(operation, 50, {
        cancel,
        cancellationGraceMs: 25,
      });
      let settled = false;
      void result.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(cancel).toHaveBeenCalledOnce();
      expect(settled).toBe(false);

      complete("cancelled and reconciled");
      await expect(result).resolves.toEqual({
        timedOut: true,
        cancellationCompleted: true,
        value: "cancelled and reconciled",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an uncooperative operation after the cancellation grace expires", async () => {
    vi.useFakeTimers();
    try {
      const operation = new Promise<string>(() => {});
      const cancel = vi.fn();
      const result = waitForPackageMutation(operation, 50, {
        cancel,
        cancellationGraceMs: 25,
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(cancel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(25);

      await expect(result).resolves.toEqual({
        timedOut: true,
        cancellationCompleted: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a cancellation failure before the grace period expires", async () => {
    vi.useFakeTimers();
    try {
      let fail!: (error: Error) => void;
      const operation = new Promise<string>((_resolve, reject) => {
        fail = reject;
      });
      const result = waitForPackageMutation(operation, 50, {
        cancel: () => fail(new Error("abort failed")),
        cancellationGraceMs: 25,
      });
      const rejection = expect(result).rejects.toThrow("abort failed");

      await vi.advanceTimersByTimeAsync(50);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
