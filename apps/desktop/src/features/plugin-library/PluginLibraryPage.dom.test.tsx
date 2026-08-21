/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  PackageMutationResult,
  PackageRecord,
  PackageSnapshot,
  PluginLibraryCatalog,
  ResourceRecord,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { PluginLibraryPage } from "./PluginLibraryPage";

const { shellOpen } = vi.hoisted(() => ({ shellOpen: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shellOpen }));

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

const REPO_SOURCE = "git:github.com/Nick12138/my-pi-plugins";

function host(overrides: Partial<HostStatusSnapshot> = {}): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "C:/agent",
    phase: "ready",
    capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
    ...overrides,
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: "w1",
    revision: 1,
    cwd: "C:/workspace",
    canonicalCwd: "C:/workspace",
    servicesReady: true,
  };
}

function catalog(): PluginLibraryCatalog {
  return {
    specVersion: 1,
    registryUrl: "https://raw.githubusercontent.com/Nick12138/my-pi-plugins/main/plugins.json",
    repoSource: REPO_SOURCE,
    fetchedAt: Date.now(),
    warnings: [],
    plugins: [
      {
        id: "pi-browser",
        name: "浏览器",
        description: "BetterWright browser.",
        icon: "🌐",
        version: "1.10.0",
        install: { type: "npm", source: "npm:betterwright" },
      },
      {
        id: "pi-web",
        name: "联网搜索",
        description: "Tavily + Exa.",
        icon: "🔍",
        version: "0.1.0",
        install: { type: "repo", path: "packages/pi-web" },
        config: [
          {
            key: "tavilyApiKey",
            type: "text",
            label: "Tavily API Key",
            env: "TAVILY_API_KEY",
            secret: true,
          },
        ],
      },
    ],
  };
}

function packageRecord(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    id: "pkg-browser",
    identity: "npm:betterwright",
    source: "npm:betterwright",
    kind: "npm",
    scope: "user",
    filtered: false,
    installed: true,
    displayName: "betterwright",
    versionOrRef: "1.10.0",
    effective: true,
    resourceCounts: null,
    resourceCountsState: "resolvedEffective",
    ...overrides,
  };
}

function resource(overrides: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    id: "res-1",
    type: "extension",
    name: "ext",
    path: "C:/agent/npm/node_modules/betterwright/dist/src/pi-extension.js",
    scope: "user",
    origin: "package",
    source: "betterwright",
    packageId: "pkg-browser",
    enabled: true,
    preferences: {},
    control: { kind: "preference", scopes: ["user"] },
    diagnostics: [],
    ...overrides,
  };
}

function emptySnapshot(): PackageSnapshot {
  return {
    revision: 1,
    workspaceId: "w1",
    scope: "all",
    configured: [],
    resources: [],
    updateCheck: { supported: false },
    diagnostics: [],
  };
}

function snapshotWithBrowser(enabled: boolean): PackageSnapshot {
  return {
    ...emptySnapshot(),
    configured: [packageRecord()],
    resources: [resource({ enabled })],
  };
}

function snapshotWithRepo(webEnabled: boolean): PackageSnapshot {
  const repoPkg = packageRecord({
    id: "pkg-repo",
    identity: "git:github.com/Nick12138/my-pi-plugins",
    source: REPO_SOURCE,
    kind: "git",
    displayName: "my-pi-plugins",
  });
  return {
    ...emptySnapshot(),
    configured: [repoPkg],
    resources: [
      resource({
        id: "res-web",
        packageId: "pkg-repo",
        path: "C:/agent/git/github.com/Nick12138/my-pi-plugins/packages/pi-web/extensions/pi-web.ts",
        enabled: webEnabled,
      }),
      resource({
        id: "res-ocr",
        packageId: "pkg-repo",
        path: "C:/agent/git/github.com/Nick12138/my-pi-plugins/packages/pi-ocr/extensions/pi-ocr.ts",
        enabled: false,
      }),
    ],
  };
}

function envelope<M extends string, R>(method: M, result: R): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: `${method}-test`,
    method,
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    ok: true,
    result,
  } as HostResponseEnvelope;
}

function mutationResult(current: PackageSnapshot): PackageMutationResult {
  return {
    operationId: "op-1",
    status: "committed",
    packageSnapshot: current,
    warnings: [],
    reconcileRequired: false,
  };
}

describe("PluginLibraryPage DOM workflows", () => {
  let request: MockInstance<typeof hostClient.request>;
  let currentSnapshot: PackageSnapshot;

  beforeEach(() => {
    currentSnapshot = emptySnapshot();
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applyPackageSnapshot(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    tauriMocks.invoke.mockReset();
    tauriMocks.isTauri.mockReset();
    tauriMocks.isTauri.mockReturnValue(true);
    // Desktop settings start loaded so persistDesktopSettings does not no-op.
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "legacy-modal",
      terminalProfile: "auto",
    } as never);
    tauriMocks.invoke.mockImplementation(async (command: string, payload: unknown) => {
      if (command === "desktop_settings_patch") {
        const current = (useAppStore.getState().desktopSettings ?? {}) as Record<string, unknown>;
        const next = {
          ...current,
          ...((payload as { patch: Record<string, unknown> }).patch ?? {}),
        };
        useAppStore.getState().setDesktopSettings(next as never);
        return next;
      }
      throw new Error(`Unexpected invoke ${command}`);
    });
    request = vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method === "pluginLibrary.catalog") return envelope(method, catalog());
      if (method === "package.list") return envelope(method, currentSnapshot);
      if (
        method === "package.install" ||
        method === "resource.setPreferences" ||
        method === "pluginLibrary.apply"
      ) {
        return envelope(method, mutationResult(currentSnapshot));
      }
      if (method === "pluginLibrary.setEnv") return envelope(method, { applied: 1 });
      throw new Error(`Unexpected method ${method}`);
    });
  });

  afterEach(() => {
    request.mockRestore();
    cleanup();
  });

  it("renders registry cards; the switch carries the enabled state", async () => {
    currentSnapshot = snapshotWithRepo(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    render(<PluginLibraryPage />);

    // Installed + configurable: gear button plus an ON switch in the header.
    const webCard = (await screen.findByText("联网搜索")).closest("article")!;
    expect(within(webCard).getByRole("button", { name: "Configure" })).toBeInTheDocument();
    expect(within(webCard).getByRole("switch")).toHaveAttribute("aria-checked", "true");
    // No separate status badge; the switch is the state.
    expect(webCard.querySelector("[data-plugin-status]")).toBeNull();
    // No form rendered until the dialog opens.
    expect(screen.queryByRole("dialog")).toBeNull();

    // Not-installed npm plugin without a config schema: Install button, no switch, no gear.
    const browserCard = screen.getByText("浏览器").closest("article")!;
    expect(within(browserCard).queryByRole("switch")).toBeNull();
    expect(within(browserCard).queryByRole("button", { name: "Configure" })).toBeNull();
    expect(within(browserCard).getByRole("button", { name: "Install…" })).toBeInTheDocument();

    // Flipping the snapshot: the browser plugin appears with a switch, the web
    // plugin drops back to Install-only.
    currentSnapshot = snapshotWithBrowser(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    await waitFor(() =>
      expect(within(browserCard).getByRole("switch")).toHaveAttribute("aria-checked", "true"),
    );
    expect(within(webCard).queryByRole("button", { name: "Configure" })).not.toBeInTheDocument();
    expect(within(webCard).queryByRole("switch")).toBeNull();
    expect(within(webCard).getByRole("button", { name: "Install…" })).toBeInTheDocument();
  });

  it("flips the switch immediately, applies in the background, and reverts on failure", async () => {
    currentSnapshot = snapshotWithBrowser(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findByText("浏览器")).closest("article")!;
    const toggle = within(card).getByRole("switch");

    // Optimistic: flips before the request resolves.
    let resolveRequest: ((value: unknown) => void) | undefined;
    request.mockImplementationOnce(
      () =>
        new Promise<never>((resolve) => {
          resolveRequest = resolve as (value: unknown) => void;
        }),
    );
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");

    // Success: snapshot lands, no toast, switch stays off.
    const toastsBeforeSuccess = useAppStore.getState().notifications.length;
    currentSnapshot = snapshotWithBrowser(false);
    currentSnapshot.revision = 2;
    resolveRequest!(envelope("resource.setPreferences", mutationResult(currentSnapshot)));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "resource.setPreferences",
        expect.objectContaining({ expectedWorkspaceId: "w1" }),
        {
          updates: [{ resourceId: "res-1", targetScope: "user", preference: "disabled" }],
        },
        expect.any(Number),
      ),
    );
    await waitFor(() => expect(useAppStore.getState().packages?.revision).toBe(2));
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(useAppStore.getState().notifications.length).toBe(toastsBeforeSuccess);

    // Failure: error toast and the switch reverts.
    await waitFor(() => expect(within(card).getByRole("switch")).not.toBeDisabled());
    request.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await user.click(within(card).getByRole("switch"));
    // The optimistic flip may already be gone by the time the click resolves —
    // the failed request rejects in the same microtask burst. What matters is
    // the end state: reverted switch + error toast, no success toast.
    await waitFor(() =>
      expect(within(card).getByRole("switch")).toHaveAttribute("aria-checked", "false"),
    );
    await waitFor(() =>
      expect(
        useAppStore
          .getState()
          .notifications.some((notification) => notification.message.includes("boom")),
      ).toBe(true),
    );
  });

  it("opens the shared config dialog from the gear button", async () => {
    currentSnapshot = snapshotWithRepo(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const webCard = (await screen.findByText("联网搜索")).closest("article")!;
    await user.click(within(webCard).getByRole("button", { name: "Configure" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("联网搜索");
    expect(within(dialog).getByLabelText(/Tavily API Key/)).toBeInTheDocument();
    expect(dialog.querySelector('input[type="password"]')).not.toBeNull();

    // Cancel closes without persisting.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("installs an npm plugin via package.install after review", async () => {
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findByText("浏览器")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Install…" }));
    await user.click(await screen.findByRole("button", { name: "Install plugin" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "package.install",
        expect.objectContaining({ expectedWorkspaceId: "w1" }),
        { source: "npm:betterwright", scope: "user" },
        expect.any(Number),
      ),
    );
  });

  it("toggles an installed npm plugin via resource.setPreferences", async () => {
    currentSnapshot = snapshotWithBrowser(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findByText("浏览器")).closest("article")!;
    await user.click(within(card).getByRole("switch"));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "resource.setPreferences",
        expect.objectContaining({ expectedWorkspaceId: "w1" }),
        {
          updates: [{ resourceId: "res-1", targetScope: "user", preference: "disabled" }],
        },
        expect.any(Number),
      ),
    );
  });

  it("installs and toggles a repo plugin through pluginLibrary.apply", async () => {
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findByText("联网搜索")).closest("article")!;
    // Initially nothing in the repo is installed: the card offers Install only.
    expect(within(card).getByRole("button", { name: "Install…" })).toBeInTheDocument();
    expect(within(card).queryByRole("switch")).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Install…" }));
    await user.click(screen.getByRole("button", { name: "Install plugin" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pluginLibrary.apply",
        expect.objectContaining({ expectedWorkspaceId: "w1" }),
        {
          source: REPO_SOURCE,
          pattern: "packages/pi-web/extensions/**",
          enabled: true,
        },
        expect.any(Number),
      ),
    );

    // After the library snapshot includes the plugin, disabling goes through apply too.
    currentSnapshot = snapshotWithRepo(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    await waitFor(() => expect(within(card).getByRole("switch")).toBeInTheDocument());
    await user.click(within(card).getByRole("switch"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pluginLibrary.apply",
        expect.objectContaining({ expectedWorkspaceId: "w1" }),
        {
          source: REPO_SOURCE,
          pattern: "packages/pi-web/extensions/**",
          enabled: false,
        },
        expect.any(Number),
      ),
    );
  });

  it("persists plugin config via the dialog and applies env vars live", async () => {
    currentSnapshot = snapshotWithRepo(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findByText("联网搜索")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Configure" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText(/Tavily API Key/);
    await user.type(input, "tvly-test-key");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith(
        "desktop_settings_patch",
        expect.objectContaining({
          patch: expect.objectContaining({
            pluginEnv: { "pi-web": { TAVILY_API_KEY: "tvly-test-key" } },
          }),
        }),
      ),
    );
    // Live application into the running Host — no restart required.
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pluginLibrary.setEnv",
        expect.objectContaining({ expectedHostInstanceId: "h1" }),
        { vars: { TAVILY_API_KEY: "tvly-test-key" } },
        expect.any(Number),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
