/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../lib/stores/app-store";
import { NotificationCenter } from "./NotificationCenter";

function push(message: string, level = "info") {
  act(() => useAppStore.getState().pushNotification(message, level));
}

describe("NotificationCenter", () => {
  beforeEach(() => {
    act(() => useAppStore.getState().clearNotifications());
  });

  afterEach(() => {
    act(() => useAppStore.getState().clearNotifications());
    cleanup();
  });

  it("counts only unread notifications and clears the badge on open", async () => {
    render(<NotificationCenter />);
    push("first");
    push("second", "error");

    const bell = screen.getByRole("button", { name: /2/ });
    expect(bell).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(bell);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Notifications/ })).not.toHaveTextContent("2");

    // Reopening later shows no badge: everything is already read.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("2")).not.toBeInTheDocument();
  });

  it("stacks up to three toasts, newest last", () => {
    render(<NotificationCenter />);
    push("one");
    push("two");
    push("three");
    push("four");

    const stack = screen.getByRole("status");
    const toasts = within(stack).getAllByRole("button");
    expect(toasts).toHaveLength(3);
    expect(toasts[0]).toHaveTextContent("two");
    expect(toasts[2]).toHaveTextContent("four");
  });

  it("opens the panel and marks everything read when a toast is clicked", async () => {
    render(<NotificationCenter />);
    push("install finished", "success");

    const user = userEvent.setup();
    await user.click(within(screen.getByRole("status")).getByText("install finished"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(useAppStore.getState().notifications.every((item) => item.read)).toBe(true);
  });

  it("does not toast notifications that arrive while the panel is open", async () => {
    render(<NotificationCenter />);
    push("before");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /1/ }));

    push("while open");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(useAppStore.getState().notifications.every((item) => item.read)).toBe(true);
  });
});
