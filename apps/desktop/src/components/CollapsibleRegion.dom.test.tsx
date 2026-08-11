/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollapsibleRegion } from "./CollapsibleRegion";

let nextFrameId = 1;
let frames = new Map<number, FrameRequestCallback>();

function flushFrame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}

describe("CollapsibleRegion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nextFrameId = 1;
    frames = new Map();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => {
        frames.delete(id);
      }),
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reveals new content once and does not replay motion for child updates", () => {
    const { container, rerender } = render(
      <CollapsibleRegion open={false} id="details">
        <button type="button">Initial detail</button>
      </CollapsibleRegion>,
    );
    const region = container.querySelector<HTMLElement>("[data-collapsible-region]")!;

    expect(region).toHaveAttribute("data-state", "closed");
    expect(region).toHaveAttribute("aria-hidden", "true");
    expect(region).toHaveAttribute("inert");
    expect(screen.queryByRole("button", { name: "Initial detail" })).not.toBeInTheDocument();

    rerender(
      <CollapsibleRegion open id="details">
        <button type="button">Initial detail</button>
      </CollapsibleRegion>,
    );
    expect(screen.getByRole("button", { name: "Initial detail" })).toBeInTheDocument();
    expect(region).toHaveAttribute("data-state", "closed");
    expect(region).not.toHaveAttribute("aria-hidden");
    expect(region).not.toHaveAttribute("inert");

    flushFrame();
    expect(region).toHaveAttribute("data-state", "closed");
    flushFrame();
    expect(region).toHaveAttribute("data-state", "open");

    rerender(
      <CollapsibleRegion open id="details">
        <button type="button">Streamed detail</button>
      </CollapsibleRegion>,
    );
    expect(screen.getByRole("button", { name: "Streamed detail" })).toBeInTheDocument();
    expect(region).toHaveAttribute("data-state", "open");
    expect(frames).toHaveLength(0);
  });

  it("retains content through exit and unmounts it after the fallback delay", () => {
    const { container, rerender } = render(
      <CollapsibleRegion open>
        <button type="button">Detail</button>
      </CollapsibleRegion>,
    );
    const region = container.querySelector<HTMLElement>("[data-collapsible-region]")!;

    rerender(
      <CollapsibleRegion open={false}>
        <button type="button">Detail</button>
      </CollapsibleRegion>,
    );
    expect(region).toHaveAttribute("data-state", "closed");
    expect(region).toHaveAttribute("aria-hidden", "true");
    expect(region).toHaveAttribute("inert");
    expect(screen.getByText("Detail")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(179));
    expect(screen.getByText("Detail")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Detail")).not.toBeInTheDocument();
  });

  it("cancels a pending unmount when the region is reopened", () => {
    const { container, rerender } = render(
      <CollapsibleRegion open>
        <span>Detail</span>
      </CollapsibleRegion>,
    );
    const region = container.querySelector<HTMLElement>("[data-collapsible-region]")!;

    rerender(
      <CollapsibleRegion open={false}>
        <span>Detail</span>
      </CollapsibleRegion>,
    );
    act(() => vi.advanceTimersByTime(60));
    rerender(
      <CollapsibleRegion open>
        <span>Detail</span>
      </CollapsibleRegion>,
    );
    expect(region).toHaveAttribute("data-state", "open");

    fireEvent.transitionEnd(region, { propertyName: "grid-template-rows" });
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByText("Detail")).toBeInTheDocument();
    expect(region).toHaveAttribute("data-state", "open");
  });

  it("changes state immediately when reduced motion is requested", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const { container, rerender } = render(
      <CollapsibleRegion open={false}>
        <span>Detail</span>
      </CollapsibleRegion>,
    );
    const region = container.querySelector<HTMLElement>("[data-collapsible-region]")!;

    rerender(
      <CollapsibleRegion open>
        <span>Detail</span>
      </CollapsibleRegion>,
    );
    expect(region).toHaveAttribute("data-state", "open");
    expect(screen.getByText("Detail")).toBeInTheDocument();

    rerender(
      <CollapsibleRegion open={false}>
        <span>Detail</span>
      </CollapsibleRegion>,
    );
    expect(region).toHaveAttribute("data-state", "closed");
    expect(screen.queryByText("Detail")).not.toBeInTheDocument();
  });
});
