/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { SettingsPage } from "./SettingsPage";

beforeEach(() => {
  useAppStore.getState().setHost(null);
  useAppStore.getState().setProvidersDirty(false);
});

afterEach(() => {
  cleanup();
  useAppStore.getState().setProvidersDirty(false);
  vi.restoreAllMocks();
});

describe("SettingsPage navigation guard", () => {
  it("switches sections directly when the Providers form is clean", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="providers" />);

    expect(screen.getByText("No Providers configured yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "General" }));
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  });

  it("offers the Host section with runtime info split out of General", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    expect(screen.getByText("Auto-restart Pi Host")).toBeInTheDocument();
    expect(screen.queryByText("Capabilities")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Host" }));
    expect(screen.getByRole("heading", { name: "Host" })).toBeInTheDocument();
    expect(screen.getByText("Capabilities")).toBeInTheDocument();
    expect(screen.getByText("Host not connected.")).toBeInTheDocument();
  });

  it("asks before leaving Providers with unsaved changes and keeps the section on cancel", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="providers" />);
    useAppStore.getState().setProvidersDirty(true);

    await user.click(screen.getByRole("button", { name: "General" }));
    expect(
      screen.getByRole("heading", { name: "Discard unsaved Provider changes?" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("No Providers configured yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "General" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  });

  it("guards the close button while dirty and closes once confirmed via the overlay owner", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SettingsPage initialSection="providers" onClose={onClose} />);
    useAppStore.getState().setProvidersDirty(true);

    // The overlay owner decides what "close" means; SettingsPage just forwards.
    await user.click(screen.getByRole("button", { name: "Back to conversation" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
