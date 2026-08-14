import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoMountFloor,
  createBatchSizer,
  FULL_MOUNT_MAX_ROWS,
  scheduleIdleMount,
} from "./progressive-mount";

describe("createBatchSizer", () => {
  it("shrinks batches when a batch blows the time budget", () => {
    const sizer = createBatchSizer(40);
    sizer.record(100);
    expect(sizer.size()).toBe(20);
    sizer.record(100);
    expect(sizer.size()).toBe(10);
  });

  it("grows batches when batches are cheap", () => {
    const sizer = createBatchSizer(16);
    sizer.record(2);
    expect(sizer.size()).toBe(24);
  });

  it("holds steady inside the comfort band", () => {
    const sizer = createBatchSizer(16);
    sizer.record(10);
    expect(sizer.size()).toBe(16);
  });

  it("keeps the size within bounds under sustained pressure", () => {
    const sizer = createBatchSizer(8);
    for (let i = 0; i < 10; i++) sizer.record(1_000);
    expect(sizer.size()).toBe(4);
    for (let i = 0; i < 20; i++) sizer.record(0);
    expect(sizer.size()).toBe(200);
  });
});

describe("autoMountFloor", () => {
  it("converges small sessions all the way to zero hidden rows", () => {
    expect(autoMountFloor(0)).toBe(0);
    expect(autoMountFloor(150)).toBe(0);
    expect(autoMountFloor(FULL_MOUNT_MAX_ROWS)).toBe(0);
  });

  it("keeps rows beyond the cap behind the manual control", () => {
    expect(autoMountFloor(FULL_MOUNT_MAX_ROWS + 1)).toBe(1);
    expect(autoMountFloor(FULL_MOUNT_MAX_ROWS + 500)).toBe(500);
  });

  it("supports a custom cap", () => {
    expect(autoMountFloor(150, 100)).toBe(50);
    expect(autoMountFloor(80, 100)).toBe(0);
  });
});

describe("scheduleIdleMount", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("prefers requestIdleCallback when the host provides it", () => {
    const cancelIdleCallback = vi.fn();
    const requestIdleCallback = vi.fn().mockReturnValue(7);
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);

    const run = vi.fn();
    const cancel = scheduleIdleMount(run);

    expect(requestIdleCallback).toHaveBeenCalledWith(run, { timeout: 500 });
    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
  });

  it("falls back to a timer on hosts without requestIdleCallback", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    scheduleIdleMount(run);

    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents the fallback timer from running", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const cancel = scheduleIdleMount(run);
    cancel();
    vi.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();
  });
});
