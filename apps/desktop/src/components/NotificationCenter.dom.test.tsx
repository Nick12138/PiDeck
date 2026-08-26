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

  it("counts only unread persistent notifications and clears the badge on open", async () => {
    render(<NotificationCenter />);
    // Info-level notifications are transient (toast only) and do not show the bell.
    push("transient info");
    // Only warning/error level notifications are persistent and drive the bell badge.
    push("first", "warning");
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

  it("shows the busy message as a toast without keeping it in notification history", () => {
    render(<NotificationCenter />);
    push("Agent 正忙，请等待当前运行结束后再试。");

    // Toast-only: it surfaces as a transient status toast…
    expect(screen.getByRole("status")).toHaveTextContent("Agent 正忙，请等待当前运行结束后再试。");

    // …but it never enters the notification history, never drives the bell badge,
    // and only lives in the transient toast feed.
    expect(useAppStore.getState().notifications).toHaveLength(0);
    expect(useAppStore.getState().transientNotifications.map((n) => n.message)).toEqual([
      "Agent 正忙，请等待当前运行结束后再试。",
    ]);
    expect(screen.queryByRole("button", { name: /Notifications \(/ })).not.toBeInTheDocument();
  });

  it("opens the panel and marks everything read when a persistent toast is clicked", async () => {
    render(<NotificationCenter />);
    // Only persistent (warning/error) toasts open the panel when clicked.
    push("install failed", "error");

    const user = userEvent.setup();
    await user.click(within(screen.getByRole("status")).getByText("install failed"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(useAppStore.getState().notifications.every((item) => item.read)).toBe(true);
  });

  it("does not toast notifications that arrive while the panel is open", async () => {
    render(<NotificationCenter />);
    // Use a persistent notification so the bell button is rendered.
    push("before", "error");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /1/ }));

    push("while open", "error");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(useAppStore.getState().notifications.every((item) => item.read)).toBe(true);
  });
});
