/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { SubagentsPanel } from "./SubagentsPanel";

const baseStatus = {
  version: 1 as const,
  available: true,
  generatedAt: 1,
  totalActive: 1,
  omitted: 0,
  fleet: [],
};

afterEach(() => {
  cleanup();
  useAppStore.setState({
    subagentsStatus: {
      ...baseStatus,
      totalActive: 0,
      runs: [],
    },
  });
});

describe("SubagentsPanel", () => {
  it("renders nested children as independently collapsible rows", () => {
    useAppStore.setState({
      subagentsStatus: {
        ...baseStatus,
        runs: [
          {
            id: "run-1",
            kind: "workflow",
            label: "worker workflow",
            state: "running",
            children: [
              {
                id: "step-1",
                kind: "step",
                label: "reviewer",
                state: "running",
                activity: { currentTool: "read" },
              },
            ],
          },
        ],
      },
    });

    render(<SubagentsPanel />);

    expect(screen.getByRole("button", { name: /worker workflow/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /reviewer/ })).toBeVisible();
    expect(screen.getByText("read")).toBeVisible();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.getAllByTitle("Running")).toHaveLength(2);
  });

  it("counts only running tasks in the header", () => {
    useAppStore.setState({
      subagentsStatus: {
        ...baseStatus,
        runs: [
          {
            id: "running",
            kind: "subagent",
            label: "running task",
            role: "reviewer",
            state: "running",
          },
          {
            id: "complete",
            kind: "subagent",
            label: "complete task",
            state: "complete",
          },
          {
            id: "failed",
            kind: "subagent",
            label: "failed task",
            state: "failed",
          },
          {
            id: "queued",
            kind: "subagent",
            label: "queued task",
            state: "queued",
          },
        ],
      },
    });

    render(<SubagentsPanel />);

    expect(screen.getByText("Active: 1")).toBeVisible();
    const roleBadge = screen.getByText("Reviewer");
    const row = roleBadge.closest("button");
    expect(roleBadge).toBeVisible();
    expect(row).not.toBeNull();
    expect(row?.textContent?.indexOf("Reviewer")).toBeLessThan(
      row?.textContent?.indexOf("running task") ?? -1,
    );
    expect(row?.querySelector("svg")).toBeInTheDocument();
    expect(row?.querySelector("svg")?.classList).toContain("animate-spin");
  });

  it("expands conversation inline instead of navigating away", () => {
    useAppStore.setState({
      subagentsStatus: {
        ...baseStatus,
        runs: [
          {
            id: "run-inline",
            kind: "subagent",
            label: "Inline task",
            state: "running",
          },
        ],
      },
    });

    render(<SubagentsPanel />);
    const row = screen.getByRole("button", { name: "Inline task" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByLabelText("Back to subagents")).not.toBeInTheDocument();
  });

  it("shows a stop button only for running rows", () => {
    useAppStore.setState({
      subagentsStatus: {
        ...baseStatus,
        runs: [
          { id: "running", kind: "subagent", label: "Running task", state: "running" },
          { id: "done", kind: "subagent", label: "Done task", state: "complete" },
        ],
      },
    });

    render(<SubagentsPanel />);
    expect(screen.getByRole("button", { name: "Stop subagent" })).toBeVisible();
    fireEvent.mouseEnter(screen.getByText("Running task"));
    expect(screen.queryByRole("button", { name: "Stop subagent" })).toBeVisible();
  });

  it("shows a useful empty state when no child is active", () => {
    useAppStore.setState({
      subagentsStatus: {
        ...baseStatus,
        totalActive: 0,
        runs: [],
      },
    });
    render(<SubagentsPanel />);
    expect(screen.getByText("No active subagents.")).toBeVisible();
  });
});
