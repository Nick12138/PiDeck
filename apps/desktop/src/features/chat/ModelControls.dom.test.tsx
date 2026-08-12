/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  ModelSummary,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { ModelControls } from "./ModelControls";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const MODEL: ModelSummary = {
  provider: "muapi",
  modelId: "grok-4.5",
  name: "Grok 4.5",
  thinkingLevels: ["off", "high"],
};
const LONG_NAME_MODEL: ModelSummary = {
  provider: "muapi",
  modelId: "grok-4.5-long-preview",
  name: "Grok 4.5 Long Running Preview",
  thinkingLevels: ["off", "high"],
};

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  };
}

function session(model: ModelSummary = MODEL): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
    revision: 3,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    model,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 1, steering: [], followUp: [] },
    contextUsage: { tokens: 0, contextWindow: 100_000 },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
  };
}

function envelope(method: string, result: unknown): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: "test-request",
    method,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    ok: true,
    result,
  } as HostResponseEnvelope;
}

describe("ModelControls model menu width", () => {
  const initialInnerWidth = window.innerWidth;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_000 });
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      language: "en",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "legacy-modal",
      terminalProfile: "auto",
    });
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: initialInnerWidth,
    });
    useAppStore.getState().setDesktopSettings(null);
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
  });

  it("opens the model menu with no manual drag handle", async () => {
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method !== "model.list") throw new Error(`Unexpected method ${method}`);
      return envelope(method, {
        models: [MODEL],
        current: MODEL,
        thinkingLevels: ["off", "high"],
        enabledProviders: ["muapi"],
      }) as never;
    });
    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(screen.getByRole("button", { name: "muapi/Grok 4.5" }));
    await screen.findByRole("menu", { name: "Models" });

    // The floated width tracks the model names automatically — no drag handle.
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("floats the width to fit the widest model name in the list", async () => {
    // jsdom reports scrollWidth = 0 for the hidden measure span, so synthesise
    // measured widths so the auto-width effect has something to clamp. The
    // width is recomputed during the render triggered by model.list.
    const measuredWidth = 400;
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method !== "model.list") throw new Error(`Unexpected method ${method}`);
      return envelope(method, {
        models: [MODEL, LONG_NAME_MODEL],
        current: MODEL,
        thinkingLevels: ["off", "high"],
        enabledProviders: ["muapi"],
      }) as never;
    });
    const scrollWidthSpy = vi
      .spyOn(Element.prototype, "scrollWidth", "get")
      .mockImplementation(function (this: Element) {
        // Only the hidden measure span carries the menu labels; let other
        // elements fall through to jsdom's default (steers clear of the panel's
        // own scrollWidth) so layout maths still work.
        return measuredWidth;
      });

    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(screen.getByRole("button", { name: "muapi/Grok 4.5" }));
    const menu = await screen.findByRole("menu", { name: "Models" });
    const menuShell = menu.parentElement;

    // measured content (400) + row controls (48) exceeds the 280 default max,
    // so the floated shell caps at the maximum width.
    await waitFor(() => expect(menuShell).toHaveStyle({ width: "280px" }));

    scrollWidthSpy.mockRestore();
  });

  it("keeps the minimum width when model names are short", async () => {
    const measuredWidth = 10;
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method !== "model.list") throw new Error(`Unexpected method ${method}`);
      return envelope(method, {
        models: [MODEL],
        current: MODEL,
        thinkingLevels: ["off", "high"],
        enabledProviders: ["muapi"],
      }) as never;
    });
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (
      this: Element,
    ) {
      return measuredWidth;
    });

    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(screen.getByRole("button", { name: "muapi/Grok 4.5" }));
    const menu = await screen.findByRole("menu", { name: "Models" });
    const menuShell = menu.parentElement;

    // Short names never drop below the minimum width.
    await waitFor(() => expect(menuShell).toHaveStyle({ width: "120px" }));
  });
});
