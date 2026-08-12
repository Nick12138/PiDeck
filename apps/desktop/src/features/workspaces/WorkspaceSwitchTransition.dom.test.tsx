/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { WorkspaceSwitchTransition } from "./WorkspaceSwitchTransition";

describe("WorkspaceSwitchTransition", () => {
  afterEach(() => {
    useAppStore.getState().setWorkspaceSwitchTarget(null);
    cleanup();
  });

  it("renders children without a skeleton when idle", () => {
    render(
      <WorkspaceSwitchTransition>
        <p>conversation</p>
      </WorkspaceSwitchTransition>,
    );
    expect(screen.getByText("conversation")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("hides the stale content behind a named skeleton while switching", () => {
    render(
      <WorkspaceSwitchTransition>
        <p>conversation</p>
      </WorkspaceSwitchTransition>,
    );
    act(() => useAppStore.getState().setWorkspaceSwitchTarget("/Users/me/Projects/PiDeck"));

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Opening PiDeck…");
    expect(screen.getByText("conversation").closest("[aria-hidden]")).not.toBeNull();
  });

  it("removes the skeleton after the switch settles", async () => {
    render(
      <WorkspaceSwitchTransition>
        <p>conversation</p>
      </WorkspaceSwitchTransition>,
    );
    act(() => useAppStore.getState().setWorkspaceSwitchTarget("/tmp/other"));
    expect(screen.getByRole("status")).toBeInTheDocument();

    act(() => useAppStore.getState().setWorkspaceSwitchTarget(null));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByText("conversation").closest("[aria-hidden]")).toBeNull();
  });
});
