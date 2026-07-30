/** @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import type {
  GitStatusSnapshot,
  HostResponseEnvelope,
  HostStatusSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { ChangesPanel } from "./ChangesPanel";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (index: number) => number }) => ({
    getTotalSize: () => Array.from({ length: count }, (_, index) => estimateSize(index)).reduce((sum, size) => sum + size, 0),
    getVirtualItems: () => {
      let start = 0;
      return Array.from({ length: count }, (_, index) => {
        const size = estimateSize(index);
        const item = { key: index, index, start, size };
        start += size;
        return item;
      });
    },
  }),
}));

const host = {
  hostInstanceId: "00000000-0000-4000-8000-000000000101",
} as HostStatusSnapshot;
const workspace = {
  id: "00000000-0000-4000-8000-000000000201",
  revision: 3,
  canonicalCwd: "/repo/apps/desktop",
} as WorkspaceSnapshot;

function status(overrides: Partial<Extract<GitStatusSnapshot, { state: "ready" }>> = {}): Extract<GitStatusSnapshot, { state: "ready" }> {
  return {
    state: "ready",
    revision: 7,
    repositoryRoot: "/repo",
    workspaceIsRepositoryRoot: false,
    branch: "main",
    detached: false,
    unborn: false,
    headSha: "a".repeat(40),
    upstream: "origin/main",
    ahead: 1,
    behind: 2,
    indexGeneration: "b".repeat(64),
    warnings: [],
    files: [{
      path: "src/app.ts",
      staged: "modified",
      unstaged: "modified",
      conflict: false,
      submodule: false,
      pathSupported: true,
    }],
    ...overrides,
  };
}

function success<M extends string>(method: M, result: unknown): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: crypto.randomUUID(),
    method,
    hostInstanceId: host.hostInstanceId,
    workspaceId: workspace.id,
    workspaceRevision: workspace.revision,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 0,
    ok: true,
    result,
  } as unknown as HostResponseEnvelope;
}

let request: MockInstance<typeof hostClient.request>;

beforeEach(() => {
  useAppStore.setState({ host, workspace, desktopSettings: { language: "en" } as never });
  request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
    if (method === "git.setWatching") return success(method, { watching: true, snapshot: status() }) as never;
    if (method === "git.getStatus") return success(method, status()) as never;
    throw new Error(`Unexpected method ${method}`);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChangesPanel", () => {
  it("watches only while visible and renders staged plus unstaged groups", async () => {
    const { rerender } = render(<ChangesPanel visible />);

    expect(await screen.findByText("Staged Changes")).toBeVisible();
    expect(screen.getByText("Changes", { selector: "span" })).toBeVisible();
    expect(screen.getByText("The repository root is above this workspace. Changes from the entire repository are shown and can be staged.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Changes: src/app.ts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Staged Changes: src/app.ts" })).toBeVisible();

    rerender(<ChangesPanel visible={false} />);
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "git.setWatching",
        expect.any(Object),
        { enabled: false },
        12_000,
      );
    });
  });

  it("loads a file diff and returns to the list", async () => {
    request.mockImplementation(async (method) => {
      if (method === "git.setWatching") return success(method, { watching: true, snapshot: status() }) as never;
      if (method === "git.getDiff") return success(method, {
        path: "src/app.ts",
        area: "unstaged",
        patch: "@@ -1 +1 @@\n-old\n+new",
        additions: 1,
        deletions: 1,
        binary: false,
        truncated: false,
        contentGeneration: "c".repeat(64),
      }) as never;
      throw new Error(`Unexpected method ${method}`);
    });
    const user = userEvent.setup();
    render(<ChangesPanel visible />);

    await user.click(await screen.findByRole("button", { name: "Changes: src/app.ts" }));
    expect(await screen.findByText("+new")).toBeVisible();
    expect(screen.getByText("-old")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to changes" }));
    expect(screen.getByText("Staged Changes")).toBeVisible();
  });

  it("stages a file and commits staged content with Ctrl+Enter", async () => {
    const stagedOnly = status({
      revision: 8,
      files: [{
        path: "src/app.ts",
        staged: "modified",
        unstaged: null,
        conflict: false,
        submodule: false,
        pathSupported: true,
      }],
    });
    const clean = status({ revision: 9, indexGeneration: "d".repeat(64), files: [] });
    request.mockImplementation(async (method) => {
      if (method === "git.setWatching") return success(method, { watching: true, snapshot: status({ files: [{ ...status().files[0]!, staged: null }] }) }) as never;
      if (method === "git.stage") return success(method, { applied: true, snapshot: stagedOnly }) as never;
      if (method === "git.commit") return success(method, { applied: true, commitSha: "deadbeef" + "0".repeat(32), snapshot: clean }) as never;
      throw new Error(`Unexpected method ${method}`);
    });
    const user = userEvent.setup();
    render(<ChangesPanel visible />);

    await user.click(await screen.findByRole("button", { name: "Stage src/app.ts" }));
    expect(await screen.findByText("Staged Changes")).toBeVisible();
    const message = screen.getByRole("textbox", { name: "Commit message" });
    await user.type(message, "feat: update app");
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => expect(request).toHaveBeenCalledWith(
      "git.commit",
      expect.any(Object),
      { message: "feat: update app", expectedIndexGeneration: stagedOnly.indexGeneration },
      65_000,
    ));
    expect(await screen.findByText("Committed deadbeef")).toBeVisible();
    expect(screen.getByText("No changes")).toBeVisible();
  });

  it("ignores status events from another workspace", async () => {
    let handler: ((event: never) => void) | null = null;
    vi.spyOn(hostClient, "onEvent").mockImplementation((next) => {
      handler = next as (event: never) => void;
      return () => { handler = null; };
    });
    render(<ChangesPanel visible />);
    expect(await screen.findByRole("button", { name: "Changes: src/app.ts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Staged Changes: src/app.ts" })).toBeVisible();

    act(() => handler?.({
      event: "git.changed",
      hostInstanceId: host.hostInstanceId,
      workspaceId: "00000000-0000-4000-8000-000000000999",
      workspaceRevision: workspace.revision,
      payload: { snapshot: status({ files: [] }) },
    } as never));
    expect(screen.getByRole("button", { name: "Changes: src/app.ts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Staged Changes: src/app.ts" })).toBeVisible();
  });
});
