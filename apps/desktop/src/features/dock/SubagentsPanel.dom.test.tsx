/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
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

    expect(screen.getByText("worker workflow")).toBeVisible();
    expect(screen.getByText("reviewer")).toBeVisible();
    expect(screen.getByText("read")).toBeVisible();
    expect(screen.getAllByText("Running")).toHaveLength(2);
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
