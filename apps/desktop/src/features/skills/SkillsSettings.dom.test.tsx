/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  PackageMutationResult,
  PackageSnapshot,
  ResourceRecord,
  SkillInfo,
  SkillSnapshot,
  WorkspaceSnapshot,
} from "@pideck/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { SkillsSettings } from "./SkillsSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const dialogMock = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialogMock);

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
    canonicalCwd: "C:\\workspace",
    servicesReady: true,
  };
}

function loadedSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: "review",
    description: "Review changes",
    filePath: "C:/agent/skills/review/SKILL.md",
    baseDir: "C:/agent/skills/review",
    source: "user",
    scope: "user",
    origin: "top-level",
    disableModelInvocation: false,
    ...overrides,
  };
}

function skillResource(overrides: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    id: "resource:skill:review",
    type: "skill",
    name: "review",
    description: "Review changes",
    path: "C:/agent/skills/review/SKILL.md",
    relativePath: "review",
    scope: "user",
    origin: "top-level",
    source: "user",
    enabled: true,
    preferences: { user: "enabled" },
    control: { kind: "preference", scopes: ["user", "project"] },
    diagnostics: [],
    ...overrides,
  };
}

function skillSnapshot(overrides: Partial<SkillSnapshot> = {}): SkillSnapshot {
  return {
    revision: 1,
    workspaceId: "w1",
    cwd: "C:\\workspace",
    projectTrusted: true,
    skills: [loadedSkill()],
    diagnostics: [],
    configuredPaths: [{ path: "../.claude/skills", scope: "project", exists: true }],
    resourceReloadRequired: false,
    ...overrides,
  };
}

function packageSnapshot(resources: ResourceRecord[]): PackageSnapshot {
  return {
    revision: 1,
    workspaceId: "w1",
    scope: "all",
    configured: [],
    resources,
    updateCheck: { supported: true },
    diagnostics: [],
    resourceReloadRequired: false,
  };
}

function mutationResult(resources: ResourceRecord[]): PackageMutationResult {
  return {
    operationId: "00000000-0000-4000-8000-000000000501",
    status: "committed",
    packageSnapshot: packageSnapshot(resources),
    warnings: [],
    reconcileRequired: false,
  };
}

function envelope(method: string, result: unknown): HostResponseEnvelope {
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

describe("SkillsSettings", () => {
  let currentSkills: SkillSnapshot;
  let currentResources: ResourceRecord[];
  let request: MockInstance<typeof hostClient.request>;

  beforeEach(() => {
    dialogMock.open.mockReset();
    dialogMock.open.mockResolvedValue(null);
    currentSkills = skillSnapshot();
    currentResources = [skillResource()];
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applyPackageSnapshot(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    request = vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method === "skill.list") return envelope(method, currentSkills);
      if (method === "package.list") return envelope(method, packageSnapshot(currentResources));
      if (method === "resource.setPreference") {
        return envelope(method, mutationResult(currentResources));
      }
      if (method === "skill.addPath" || method === "skill.removePath") {
        return envelope(method, currentSkills);
      }
      throw new Error(`unexpected method ${method}`);
    });
  });

  afterEach(() => {
    cleanup();
    request.mockRestore();
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applyPackageSnapshot(null);
  });

  it("renders loaded skills grouped by source with configured paths", async () => {
    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByText("Global (user)")).toBeInTheDocument());
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("Review changes")).toBeInTheDocument();
    expect(screen.getByText("../.claude/skills")).toBeInTheDocument();
    expect(screen.getByText("Project trusted")).toBeInTheDocument();
    expect(request.mock.calls.some(([method]) => method === "skill.list")).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "package.list")).toBe(true);
  });

  it("disables an enabled skill via resource.setPreference at user scope", async () => {
    const user = userEvent.setup();
    render(<SkillsSettings />);
    const toggle = await screen.findByRole("switch", { name: "Toggle skill review" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(toggle);
    await waitFor(() => {
      const call = request.mock.calls.find(([method]) => method === "resource.setPreference");
      expect(call?.[2]).toEqual({
        resourceId: "resource:skill:review",
        targetScope: "user",
        preference: "disabled",
      });
    });
    await waitFor(() => expect(useAppStore.getState().packages).not.toBeNull());
  });

  it("keeps disabled skills listed with a re-enable switch", async () => {
    currentSkills = skillSnapshot({ skills: [] });
    currentResources = [
      skillResource({
        preferences: { user: "disabled" },
        enabled: false,
      }),
    ];
    render(<SkillsSettings />);
    const toggle = await screen.findByRole("switch", { name: "Toggle skill review" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(toggle);
    await waitFor(() => {
      const call = request.mock.calls.find(([method]) => method === "resource.setPreference");
      expect(call?.[2]).toMatchObject({ targetScope: "user", preference: "enabled" });
    });
  });

  it("disables the switch for extension-owned temporary skills", async () => {
    currentSkills = skillSnapshot({
      skills: [
        loadedSkill({
          name: "runtime",
          description: "Runtime skill",
          filePath: "runtime://review/SKILL.md",
          baseDir: "runtime://review",
          source: "pi-telegram",
          scope: "temporary",
          origin: "package",
        }),
      ],
    });
    currentResources = [
      skillResource({
        id: "resource:skill:runtime",
        name: "runtime",
        path: "runtime://review/SKILL.md",
        scope: "temporary",
        origin: "extension",
        control: { kind: "read-only", reason: "Temporary resource" },
      }),
    ];
    render(<SkillsSettings />);
    // The bundle group starts collapsed; expand it to reach the switch.
    const bundleHeader = await screen.findByRole("button", { name: /Packages & Extensions/ });
    expect(bundleHeader).toHaveAttribute("aria-expanded", "false");
    const user = userEvent.setup();
    await user.click(bundleHeader);
    expect(bundleHeader).toHaveAttribute("aria-expanded", "true");
    const toggle = await screen.findByRole("switch", { name: "Toggle skill runtime" });
    expect(toggle).toBeDisabled();
  });

  it("keeps global and project groups expanded by default and collapsible", async () => {
    const user = userEvent.setup();
    render(<SkillsSettings />);
    const globalHeader = await screen.findByRole("button", { name: /Global \(user\)/ });
    const projectHeader = screen.getByRole("button", { name: /Project/ });
    expect(globalHeader).toHaveAttribute("aria-expanded", "true");
    expect(projectHeader).toHaveAttribute("aria-expanded", "true");
    await user.click(globalHeader);
    expect(globalHeader).toHaveAttribute("aria-expanded", "false");
    await user.click(globalHeader);
    expect(globalHeader).toHaveAttribute("aria-expanded", "true");
  });

  it("adds a skill directory picked from the folder dialog to project settings", async () => {
    dialogMock.open.mockResolvedValue("C:/team/skills");
    const user = userEvent.setup();
    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByText("Global (user)")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    expect(dialogMock.open).toHaveBeenCalledWith({ directory: true, multiple: false });
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => {
      const call = request.mock.calls.find(([method]) => method === "skill.addPath");
      expect(call?.[2]).toEqual({ path: "C:/team/skills", scope: "project" });
    });
  });
});
