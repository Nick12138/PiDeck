import { describe, expect, it } from "vitest";
import type {
  PackageRecord,
  PackageSnapshot,
  PluginLibraryCatalog,
  PluginLibraryEntry,
  ResourceRecord,
} from "@pideck/protocol";
import {
  buildPluginEnvPatch,
  initialConfigValues,
  isVisionCapable,
  missingRequiredConfig,
  normalizeInstallIdentity,
  OPTIONS_SOURCE_VISION_MODELS,
  pluginCardState,
  repoExtensionPattern,
  visionModelOption,
  wantsVisionModelOptions,
} from "./plugin-library-model";

const CATALOG: PluginLibraryCatalog = {
  specVersion: 1,
  registryUrl: "https://raw.githubusercontent.com/Nick12138/my-pi-plugins/main/plugins.json",
  repoSource: "git:github.com/Nick12138/my-pi-plugins",
  fetchedAt: 0,
  plugins: [],
  warnings: [],
};

const BROWSER_ENTRY: PluginLibraryEntry = {
  id: "pi-browser",
  name: "浏览器",
  description: "",
  icon: "🌐",
  version: "1.10.0",
  install: { type: "npm", source: "npm:betterwright" },
};

const WEB_ENTRY: PluginLibraryEntry = {
  id: "pi-web",
  name: "联网搜索",
  description: "",
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
    {
      key: "defaultProvider",
      type: "select",
      label: "默认搜索引擎",
      env: "PI_WEB_PROVIDER",
      default: "auto",
      options: [{ value: "auto", label: "自动" }],
    },
  ],
};

function pkg(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    id: "pkg-1",
    identity: "npm:betterwright",
    source: "npm:betterwright",
    kind: "npm",
    scope: "user",
    filtered: false,
    installed: true,
    displayName: "betterwright",
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
    path: "/home/u/.pi/agent/npm/betterwright/dist/src/pi-extension.js",
    scope: "user",
    origin: "package",
    source: "betterwright",
    packageId: "pkg-1",
    enabled: true,
    preferences: {},
    control: { kind: "preference", scopes: ["user"] },
    diagnostics: [],
    ...overrides,
  };
}

function snapshot(configured: PackageRecord[], resources: ResourceRecord[] = []): PackageSnapshot {
  return {
    revision: 1,
    workspaceId: "ws",
    scope: "all",
    configured,
    resources,
    updateCheck: { supported: false },
    diagnostics: [],
    resourceReloadRequired: false,
  };
}

describe("normalizeInstallIdentity", () => {
  it("strips npm version pins", () => {
    expect(normalizeInstallIdentity("npm:betterwright@1.10.0")).toBe("npm:betterwright");
    expect(normalizeInstallIdentity("npm:@scope/pkg@2.0.0")).toBe("npm:@scope/pkg");
    expect(normalizeInstallIdentity("npm:betterwright")).toBe("npm:betterwright");
  });

  it("normalizes git shorthand and URLs to the same identity", () => {
    // pi lowercases the host but preserves path case.
    const expected = "git:github.com/Nick12138/my-pi-plugins";
    expect(normalizeInstallIdentity("git:github.com/Nick12138/my-pi-plugins")).toBe(
      "git:github.com/Nick12138/my-pi-plugins",
    );
    expect(normalizeInstallIdentity("https://github.com/Nick12138/my-pi-plugins.git")).toBe(
      expected,
    );
    expect(normalizeInstallIdentity("git:github:Nick12138/my-pi-plugins")).toBe(expected);
  });
});

describe("repoExtensionPattern", () => {
  it("builds a package-root-relative glob", () => {
    expect(repoExtensionPattern("packages/pi-web")).toBe("packages/pi-web/extensions/**");
  });
});

describe("pluginCardState for npm/git entries", () => {
  it("is not-installed when no package matches", () => {
    const state = pluginCardState(BROWSER_ENTRY, CATALOG, snapshot([], []));
    expect(state.status).toBe("not-installed");
    expect(state.packageRecord).toBeUndefined();
  });

  it("matches a configured package by identity ignoring version pins", () => {
    const record = pkg({ source: "npm:betterwright@1.10.0" });
    const state = pluginCardState(BROWSER_ENTRY, CATALOG, snapshot([record], []));
    expect(state.status).toBe("enabled");
    expect(state.packageRecord?.id).toBe("pkg-1");
  });

  it("is disabled when an extension resource is disabled", () => {
    const record = pkg();
    const resources = [resource({ enabled: false })];
    const state = pluginCardState(BROWSER_ENTRY, CATALOG, snapshot([record], resources));
    expect(state.status).toBe("disabled");
    expect(state.extensionResources).toHaveLength(1);
  });

  it("is enabled when the package has no extension resources", () => {
    const record = pkg();
    const state = pluginCardState(BROWSER_ENTRY, CATALOG, snapshot([record], []));
    expect(state.status).toBe("enabled");
  });
});

describe("pluginCardState for repo entries", () => {
  const repoPkg = pkg({
    id: "pkg-repo",
    source: "git:github.com/Nick12138/my-pi-plugins",
    identity: "git:github.com/Nick12138/my-pi-plugins",
    kind: "git",
  });
  const webExtension = resource({
    id: "res-web",
    packageId: "pkg-repo",
    path: "C:\\Users\\u\\.pi\\agent\\git\\github.com\\Nick12138\\my-pi-plugins\\packages\\pi-web\\extensions\\pi-web.ts",
  });
  const ocrExtension = resource({
    id: "res-ocr",
    packageId: "pkg-repo",
    path: "C:\\Users\\u\\.pi\\agent\\git\\github.com\\Nick12138\\my-pi-plugins\\packages\\pi-ocr\\extensions\\pi-ocr.ts",
  });

  it("is not-installed when the repository package is absent", () => {
    expect(pluginCardState(WEB_ENTRY, CATALOG, snapshot([], [])).status).toBe("not-installed");
  });

  it("is not-installed when the plugin has no resources in the repository package", () => {
    const state = pluginCardState(WEB_ENTRY, CATALOG, snapshot([repoPkg], [ocrExtension]));
    expect(state.status).toBe("not-installed");
  });

  it("is enabled when its extension resource is enabled", () => {
    const state = pluginCardState(
      WEB_ENTRY,
      CATALOG,
      snapshot([repoPkg], [webExtension, ocrExtension]),
    );
    expect(state.status).toBe("enabled");
    expect(state.extensionResources.map((r) => r.id)).toEqual(["res-web"]);
  });

  it("is disabled when its extension resource is disabled but present", () => {
    const state = pluginCardState(
      WEB_ENTRY,
      CATALOG,
      snapshot([repoPkg], [{ ...webExtension, enabled: false }, ocrExtension]),
    );
    expect(state.status).toBe("disabled");
  });

  it("never matches sibling plugins with a shared path prefix", () => {
    const sneaky = resource({
      id: "res-x",
      packageId: "pkg-repo",
      path: "/git/my-pi-plugins/packages/pi-web-extra/extensions/x.ts",
    });
    const state = pluginCardState(WEB_ENTRY, CATALOG, snapshot([repoPkg], [sneaky]));
    expect(state.status).toBe("not-installed");
  });
});

describe("config helpers", () => {
  it("initializes stored values over defaults", () => {
    const values = initialConfigValues(WEB_ENTRY, {
      "pi-web": { TAVILY_API_KEY: "tvly-stored" },
    });
    expect(values).toEqual({ TAVILY_API_KEY: "tvly-stored", PI_WEB_PROVIDER: "auto" });
  });

  it("buildPluginEnvPatch drops empty values and empty plugins", () => {
    const existing = { "pi-web": { TAVILY_API_KEY: "x" }, other: { K: "v" } };
    expect(buildPluginEnvPatch(existing, "pi-web", { TAVILY_API_KEY: "" })).toEqual({
      other: { K: "v" },
    });
    expect(
      buildPluginEnvPatch(existing, "pi-web", { TAVILY_API_KEY: "y", PI_WEB_PROVIDER: "" }),
    ).toEqual({ "pi-web": { TAVILY_API_KEY: "y" }, other: { K: "v" } });
  });

  it("lists missing required fields by label", () => {
    const entry: PluginLibraryEntry = {
      ...WEB_ENTRY,
      config: [
        { key: "a", type: "text", label: "API Key", env: "A_KEY", required: true },
        { key: "b", type: "text", label: "Opt", env: "B_KEY" },
      ],
    };
    expect(missingRequiredConfig(entry, {})).toEqual([{ label: "API Key" }]);
    expect(missingRequiredConfig(entry, { A_KEY: "k" })).toEqual([]);
  });

  describe("vision model helpers", () => {
    it("identifies vision-capable models by input modality", () => {
      expect(
        isVisionCapable({
          provider: "openai",
          modelId: "gpt-4o",
          name: "GPT-4o",
          input: ["text", "image"],
        }),
      ).toBe(true);
      expect(
        isVisionCapable({
          provider: "openai",
          modelId: "gpt-text",
          name: "GPT-Text",
          input: ["text"],
        }),
      ).toBe(false);
      expect(
        isVisionCapable({
          provider: "openai",
          modelId: "gpt-fallback",
          name: "Fallback",
        }),
      ).toBe(false);
    });

    it("formats options with human-readable provider and model names", () => {
      expect(
        visionModelOption({
          provider: "openai",
          providerName: "OpenAI",
          modelId: "gpt-4o-mini",
          name: "GPT-4o mini",
          input: ["text", "image"],
        }),
      ).toEqual({
        value: "openai/gpt-4o-mini",
        label: "OpenAI · GPT-4o mini",
      });

      // Falls back to IDs when display names are omitted.
      expect(
        visionModelOption({
          provider: "custom",
          modelId: "raw-model",
          name: "raw-model",
        }),
      ).toEqual({
        value: "custom/raw-model",
        label: "custom · raw-model",
      });
    });

    it("detects when a config item requests runtime vision models", () => {
      expect(
        wantsVisionModelOptions({
          key: "visionModel",
          type: "select",
          label: "l",
          env: "PI_VISION_MODEL",
          optionsSource: OPTIONS_SOURCE_VISION_MODELS,
        }),
      ).toBe(true);
      expect(
        wantsVisionModelOptions({
          key: "engine",
          type: "select",
          label: "l",
          env: "X",
          options: [{ value: "a", label: "A" }],
        }),
      ).toBe(false);
      expect(
        wantsVisionModelOptions({
          key: "custom",
          type: "select",
          label: "l",
          env: "X",
          optionsSource: "pi:other-source",
        }),
      ).toBe(false);
      expect(
        wantsVisionModelOptions({
          key: "apiKey",
          type: "text",
          label: "l",
          env: "KEY",
        }),
      ).toBe(false);
    });
  });
});
