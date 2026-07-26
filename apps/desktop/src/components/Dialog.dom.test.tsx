/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Dialog", () => {
  it("focuses the first control and wires the action buttons", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <Dialog title="Try it" confirmLabel="Apply" onCancel={onCancel} onConfirm={onConfirm}>
        <p>Body</p>
      </Dialog>,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("ignores an Escape a layer above already consumed", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    // Mirrors e.g. the extension modal: acts on Escape and preventDefaults,
    // but does not stop propagation. Registered first, so it runs first.
    const upperLayer = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", upperLayer);
    try {
      render(
        <Dialog title="Lower" confirmLabel="Go" onCancel={onCancel} onConfirm={vi.fn()}>
          <p>Body</p>
        </Dialog>,
      );

      await user.keyboard("{Escape}");

      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", upperLayer);
    }
  });

  it("consumes Escape so outer window-level close handlers never fire", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const outerClose = vi.fn();
    // Mirrors the Settings overlay listener: window-level, skips consumed events.
    const overlayHandler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      outerClose();
    };
    window.addEventListener("keydown", overlayHandler);
    try {
      render(
        <Dialog title="Inner" confirmLabel="Go" onCancel={onCancel} onConfirm={vi.fn()}>
          <p>Body</p>
        </Dialog>,
      );

      await user.keyboard("{Escape}");

      expect(onCancel).toHaveBeenCalledOnce();
      expect(outerClose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", overlayHandler);
    }
  });
});
