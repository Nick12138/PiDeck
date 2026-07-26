import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelConfigHealth, ProviderDraft } from "@pideck/protocol";
import {
  createProviderHandlers,
  getEnabledProviderIds,
  getProviderModelAllowLists,
} from "./provider-controller.js";
import { PiHostServer } from "./server.js";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";
import { createTestModelServices, putApiKey } from "./test-helpers/model-runtime.js";
import { refreshModelsLocal } from "./model-runtime-refresh.js";
import { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

const layouts: TempAgentLayout[] = [];
const httpServers: Server[] = [];

afterEach(async () => {
  for (const server of httpServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const layout of layouts.splice(0)) layout.cleanup();
});

async function setup(initialModels: unknown) {
  const layout = createTempAgentLayout("pi-provider-test-");
  layouts.push(layout);
  writeFileSync(join(layout.agentDir, "models.json"), JSON.stringify(initialModels, null, 2));
  const { credentialStore, modelRuntime, modelRegistry, providerOwnership } =
    await createTestModelServices(layout.agentDir);
  const buildHealth = (): ModelConfigHealth => ({
    state: modelRuntime.getError() ? "error" : "ok",
    source: "ModelRegistry.getError",
    ...(modelRuntime.getError() ? { message: modelRuntime.getError() } : {}),
  });
  let health: ModelConfigHealth = buildHealth();
  const factory = new WorkspaceGraphFactory({
    agentDir: layout.agentDir,
    credentialStore,
    modelRuntime,
    modelRegistry,
    providerOwnership,
    getModelConfigHealth: () => health,
    refreshModelHealth: async (signal) => {
      await refreshModelsLocal(modelRuntime, { signal });
      health = buildHealth();
      return health;
    },
    packageUpdateCheck: false,
  });
  const server = new PiHostServer({
    agentDir: layout.agentDir,
    sdkVersion: "test",
    getModelConfigHealth: () => health,
    capabilities: {
      packageUpdateCheck: false,
      extensionUi: true,
      sessionExport: false,
    },
    handlers: {},
  });
  factory.bindServer(server);
  return {
    layout,
    credentialStore,
    modelRuntime,
    server,
    handlers: createProviderHandlers(factory),
  };
}

function draft(models: ProviderDraft["models"]): ProviderDraft {
  return {
    id: "custom",
    name: "Custom Gateway",
    baseUrl: "http://127.0.0.1:8317/v1",
    modelsUrl: "https://catalog.example/v1/models",
    api: "openai-responses",
    headers: { "X-Client": "pideck" },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: null,
    },
    models,
  };
}

function writeAnthropicSuccess(response: import("node:http").ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end([
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"relay-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
    "",
  ].join("\n"));
}

describe("Provider controller", () => {
  it("migrates the active Provider and enables multiple Providers without clearing models", async () => {
    const { layout, handlers } = await setup({
      pideckActiveProvider: "other",
      providers: {
        other: {
          name: "Other",
          baseUrl: "https://other.example/v1",
          api: "openai-completions",
          models: [{ id: "other-model" }],
        },
        custom: {
          name: "Custom",
          baseUrl: "https://custom.example/v1",
          api: "openai-responses",
          models: [{ id: "custom-model" }],
        },
      },
    });

    const save = await handlers["provider.save"]!({
      id: "save-custom",
      params: {
        originalId: "custom",
        provider: draft([
          {
            id: "custom-model",
            name: "Custom model",
            reasoning: false,
            input: ["text"],
            contextWindow: 128_000,
            maxTokens: 16_384,
          },
        ]),
      },
    } as never);
    expect("error" in save ? save.error.message : null).toBeNull();
    const afterSave = JSON.parse(readFileSync(join(layout.agentDir, "models.json"), "utf8"));
    expect(afterSave.pideckEnabledProviders).toEqual(["other"]);
    expect(afterSave.pideckActiveProvider).toBeUndefined();

    const enable = await handlers["provider.setEnabled"]!({
      id: "enable-custom",
      params: { providerId: "custom", enabled: true },
    } as never);
    expect("error" in enable ? enable.error.message : null).toBeNull();

    const persisted = JSON.parse(readFileSync(join(layout.agentDir, "models.json"), "utf8"));
    expect(persisted.pideckEnabledProviders).toEqual(["other", "custom"]);
    expect(persisted.providers.other.models).toEqual([{ id: "other-model" }]);

    const list = await handlers["provider.list"]!({ id: "list-providers", params: null } as never);
    expect("error" in list).toBe(false);
    if (!("error" in list)) {
      const providers = (list.result as { providers: Array<{ id: string; enabled: boolean }> }).providers;
      expect(providers.filter((provider) => provider.enabled).map((provider) => provider.id).sort())
        .toEqual(["custom", "other"]);
    }
  });

  it("preserves unrelated configuration and keeps API keys out of models.json", async () => {
    const { layout, credentialStore, handlers } = await setup({
      version: 1,
      providers: {
        other: {
          baseUrl: "https://other.example/v1",
          api: "openai-completions",
          models: [{ id: "other-model" }],
        },
        custom: {
          name: "Old name",
          baseUrl: "https://old.example/v1",
          api: "openai-completions",
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: true,
            supportsStore: false,
          },
          models: [
            { id: "keep", compat: { supportsReasoningEffort: false } },
            { id: "hide" },
          ],
        },
      },
    });

    const outcome = await handlers["provider.save"]!({
      id: "save-1",
      params: {
        originalId: "custom",
        provider: draft([
          {
            id: "keep",
            name: "Keep",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 200_000,
            maxTokens: 20_000,
          },
        ]),
        apiKey: "secret-key",
      },
    } as never);

    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    const persisted = JSON.parse(readFileSync(join(layout.agentDir, "models.json"), "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.providers.other.models[0].id).toBe("other-model");
    expect(persisted.providers.custom.compat.supportsDeveloperRole).toBe(false);
    expect(persisted.providers.custom.compat.supportsReasoningEffort).toBeUndefined();
    expect(persisted.providers.custom.compat.supportsStore).toBe(false);
    expect(persisted.providers.custom.authHeader).toBe(true);
    expect(persisted.providers.custom.models).toHaveLength(1);
    expect(persisted.providers.custom.models[0].compat.supportsReasoningEffort).toBe(false);
    expect(persisted.providers.custom.apiKey).toBeUndefined();
    expect(await credentialStore.readRaw("custom")).toEqual({ type: "api_key", key: "secret-key" });
    if (!("error" in outcome)) {
      expect((outcome.result as { provider: { auth: { configured: boolean } } }).provider.auth.configured).toBe(true);
    }
  });

  it("chooses the native authentication default for a new Anthropic Provider", async () => {
    const { layout, handlers } = await setup({ providers: {} });
    const provider = {
      ...draft([]),
      api: "anthropic-messages" as const,
    };
    const outcome = await handlers["provider.save"]!({
      id: "save-anthropic-auth",
      params: { provider },
    } as never);

    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    const persisted = JSON.parse(readFileSync(join(layout.agentDir, "models.json"), "utf8"));
    expect(persisted.providers.custom.authHeader).toBe(false);
  });

  it("marks only already enabled remote models as selected", async () => {
    const catalogServer = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            { id: "deepseek-v4-pro" },
            { id: "enabled-model" },
            { id: "gemini-3.1-pro-preview" },
            { id: "glm-5.2" },
            { id: "gpt-5.6-sol" },
            { id: "grok-4.5" },
            { id: "remote-only" },
          ],
        }),
      );
    });
    httpServers.push(catalogServer);
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const { handlers } = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          models: [{ id: "enabled-model", name: "Enabled" }],
        },
      },
    });
    const outcome = await handlers["provider.fetchModels"]!({
      id: "fetch-1",
      params: { providerId: "custom" },
    } as never);

    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    if (!("error" in outcome)) {
      const models = (outcome.result as {
        models: Array<{
          id: string;
          enabled: boolean;
          thinkingSource: string;
          thinkingLevelMap?: Record<string, string | null>;
        }>;
      }).models;
      expect(models).toEqual([
        expect.objectContaining({
          id: "deepseek-v4-pro",
          enabled: false,
          thinkingSource: "profile",
          thinkingLevelMap: {
            off: "none",
            minimal: null,
            low: null,
            medium: null,
            high: "high",
            xhigh: null,
            max: "max",
          },
        }),
        expect.objectContaining({ id: "enabled-model", enabled: true }),
        expect.objectContaining({
          id: "gemini-3.1-pro-preview",
          enabled: false,
          thinkingSource: "profile",
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: null,
            max: null,
          },
        }),
        expect.objectContaining({
          id: "glm-5.2",
          enabled: false,
          thinkingSource: "profile",
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: "high",
            xhigh: null,
            max: "max",
          },
        }),
        expect.objectContaining({
          id: "gpt-5.6-sol",
          enabled: false,
          thinkingSource: "profile",
          thinkingLevelMap: {
            off: "none",
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: "max",
          },
        }),
        expect.objectContaining({
          id: "grok-4.5",
          enabled: false,
          contextWindow: 272_000,
          maxTokens: 65_536,
          thinkingSource: "profile",
          thinkingLevelMap: expect.objectContaining({
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
          }),
        }),
        expect.objectContaining({
          id: "remote-only",
          enabled: false,
          contextWindow: 272_000,
          maxTokens: 65_536,
        }),
      ]);
    }
  });

  it.each(["configuration", "identity"] as const)(
    "releases the graph lock during discovery and rejects stale results after %s changes",
    async (change) => {
      let markRequestStarted!: () => void;
      let releaseResponse!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve;
      });
      const responseGate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const catalogServer = createServer(async (_request, response) => {
        markRequestStarted();
        await responseGate;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "stale-model" }] }));
      });
      httpServers.push(catalogServer);
      await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
      const address = catalogServer.address();
      if (!address || typeof address === "string") throw new Error("No HTTP address");

      const fixture = await setup({
        providers: {
          custom: {
            name: "Custom",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            models: [],
          },
        },
      });
      const pending = fixture.handlers["provider.fetchModels"]!({
        id: "fetch-stale",
        params: { providerId: "custom" },
      } as never);
      await requestStarted;

      expect(fixture.server.serviceGraphLock.getOwner()).toBeNull();
      expect(fixture.server.graphOperations.getActive()).toBeNull();
      if (change === "configuration") {
        const modelsPath = join(fixture.layout.agentDir, "models.json");
        const changed = JSON.parse(readFileSync(modelsPath, "utf8"));
        changed.providers.custom.headers = { "X-Revision": "changed" };
        writeFileSync(modelsPath, JSON.stringify(changed, null, 2));
      } else {
        fixture.server.identity.bumpWorkspaceRevision();
      }
      releaseResponse();

      const outcome = await pending;
      expect("error" in outcome && outcome.error.code).toBe("STALE_REVISION");
      expect(fixture.server.serviceGraphLock.getOwner()).toBeNull();
      expect(fixture.server.graphOperations.getActive()).toBeNull();
    },
  );

  it("cancels model discovery when Host quiescing begins", async () => {
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const catalogServer = createServer((_request, _response) => {
      markRequestStarted();
    });
    httpServers.push(catalogServer);
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const fixture = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          models: [],
        },
      },
    });
    vi.spyOn(fixture.server, "shutdown").mockResolvedValue();
    const pending = fixture.handlers["provider.fetchModels"]!({
      id: "fetch-cancelled",
      params: { providerId: "custom" },
    } as never);
    await requestStarted;

    await fixture.server.requestShutdown("provider discovery test");
    const outcome = await pending;
    expect("error" in outcome && outcome.error.code).toBe("HOST_SHUTTING_DOWN");
    expect(fixture.server.serviceGraphLock.getOwner()).toBeNull();
    expect(fixture.server.graphOperations.getActive()).toBeNull();
  });

  it("discovers a root Anthropic-compatible Provider at /v1/models", async () => {
    const requests: Array<{
      url: string;
      apiKey?: string;
      authorization?: string;
      version?: string;
    }> = [];
    const catalogServer = createServer((request, response) => {
      requests.push({
        url: request.url ?? "",
        ...(typeof request.headers["x-api-key"] === "string"
          ? { apiKey: request.headers["x-api-key"] }
          : {}),
        ...(typeof request.headers.authorization === "string"
          ? { authorization: request.headers.authorization }
          : {}),
        ...(typeof request.headers["anthropic-version"] === "string"
          ? { version: request.headers["anthropic-version"] }
          : {}),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "claude-sonnet" }] }));
    });
    httpServers.push(catalogServer);
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const { credentialStore, handlers } = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}`,
          api: "anthropic-messages",
          authHeader: true,
          models: [],
        },
      },
    });
    await putApiKey(credentialStore, "custom", "stored-secret");
    const outcome = await handlers["provider.fetchModels"]!({
      id: "fetch-root",
      params: { providerId: "custom" },
    } as never);

    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    expect(requests).toEqual([
      {
        url: "/v1/models",
        apiKey: "stored-secret",
        authorization: "Bearer stored-secret",
        version: "2023-06-01",
      },
    ]);
  });

  it("falls back to /models and accepts a top-level model array", async () => {
    const requestPaths: string[] = [];
    const catalogServer = createServer((request, response) => {
      requestPaths.push(request.url ?? "");
      if (request.url === "/v1/models") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<!doctype html><title>Not the API</title>");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify([{ id: "fallback-model" }]));
    });
    httpServers.push(catalogServer);
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const { handlers } = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}`,
          api: "openai-completions",
          models: [],
        },
      },
    });
    const outcome = await handlers["provider.fetchModels"]!({
      id: "fetch-fallback",
      params: { providerId: "custom" },
    } as never);

    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    expect(requestPaths).toEqual(["/v1/models", "/models"]);
    if (!("error" in outcome)) {
      expect((outcome.result as { models: Array<{ id: string }> }).models)
        .toEqual([expect.objectContaining({ id: "fallback-model" })]);
    }
  });

  it("reports HTML model responses as a Base URL problem", async () => {
    const catalogServer = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>Gateway</title>");
    });
    httpServers.push(catalogServer);
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const { handlers } = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          models: [],
        },
      },
    });
    const outcome = await handlers["provider.fetchModels"]!({
      id: "fetch-html",
      params: { providerId: "custom" },
    } as never);

    expect("error" in outcome ? outcome.error.message : "").toContain("returned HTML instead of JSON");
    expect("error" in outcome ? outcome.error.message : "").toContain("Check the Base URL");
    expect("error" in outcome ? outcome.error.message : "").not.toContain("Unexpected token");
  });

  it("reports JSON API errors without exposing stored credentials", async () => {
    const catalogServer = createServer((request, response) => {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        error: { message: `Invalid API key ${request.headers.authorization}` },
      }));
    });
    httpServers.push(catalogServer);
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const { credentialStore, handlers } = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          models: [],
        },
      },
    });
    await putApiKey(credentialStore, "custom", "do-not-expose");
    const outcome = await handlers["provider.fetchModels"]!({
      id: "fetch-unauthorized",
      params: { providerId: "custom" },
    } as never);

    expect("error" in outcome ? outcome.error.message : "").toContain("401 Unauthorized");
    expect("error" in outcome ? outcome.error.message : "").toContain("[redacted]");
    expect("error" in outcome ? outcome.error.message : "").not.toContain("do-not-expose");
  });

  it("falls back from a versioned catalog path to /v1/models", async () => {
    const requestPaths: string[] = [];
    const catalogServer = createServer((request, response) => {
      requestPaths.push(request.url ?? "");
      if (request.url === "/v4/models") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Not found" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "version-fallback" }] }));
    });
    httpServers.push(catalogServer);
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const { handlers } = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}/v4`,
          api: "openai-completions",
          models: [],
        },
      },
    });
    const outcome = await handlers["provider.fetchModels"]!({
      id: "fetch-versioned",
      params: { providerId: "custom" },
    } as never);

    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    expect(requestPaths).toEqual(["/v4/models", "/v1/models"]);
  });

  it("strips Anthropic-compatible routing suffixes for model discovery", async () => {
    const requestPaths: string[] = [];
    const catalogServer = createServer((request, response) => {
      requestPaths.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "relay-model" }] }));
    });
    httpServers.push(catalogServer);
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const { handlers } = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}/anthropic`,
          api: "anthropic-messages",
          models: [],
        },
      },
    });
    const outcome = await handlers["provider.fetchModels"]!({
      id: "fetch-anthropic-suffix",
      params: { providerId: "custom" },
    } as never);

    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    expect(requestPaths).toEqual(["/v1/models"]);
  });

  it("uses an explicit Models URL without probing inferred paths", async () => {
    const requestPaths: string[] = [];
    const catalogServer = createServer((request, response) => {
      requestPaths.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ models: [{ id: "custom-catalog" }] }));
    });
    httpServers.push(catalogServer);
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const { handlers } = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: "https://generation.example/v1",
          modelsUrl: `http://127.0.0.1:${address.port}/catalog?channel=test`,
          api: "openai-completions",
          models: [],
        },
      },
    });
    const outcome = await handlers["provider.fetchModels"]!({
      id: "fetch-explicit",
      params: { providerId: "custom" },
    } as never);

    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    expect(requestPaths).toEqual(["/catalog?channel=test"]);
  });

  it("classifies a real Anthropic SDK request blocked by User-Agent", async () => {
    const requests: Array<{ url: string; userAgent?: string }> = [];
    const apiServer = createServer((request, response) => {
      const userAgent = typeof request.headers["user-agent"] === "string"
        ? request.headers["user-agent"]
        : undefined;
      requests.push({
        url: request.url ?? "",
        ...(userAgent ? { userAgent } : {}),
      });
      if (userAgent === "PiDeck/0.1") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end([
          "event: message_start",
          'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"relay-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
          "",
          "event: content_block_start",
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          "",
          "event: content_block_delta",
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
          "",
          "event: content_block_stop",
          'data: {"type":"content_block_stop","index":0}',
          "",
          "event: message_delta",
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
          "",
          "event: message_stop",
          'data: {"type":"message_stop"}',
          "",
          "",
        ].join("\n"));
        return;
      }
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        type: "error",
        error: { type: "permission_error", message: "Your request was blocked." },
      }));
    });
    httpServers.push(apiServer);
    await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
    const address = apiServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const { credentialStore, handlers } = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}`,
          api: "anthropic-messages",
          authHeader: false,
          models: [{ id: "relay-model" }],
        },
      },
    });
    await putApiKey(credentialStore, "custom", "do-not-expose");
    const outcome = await handlers["provider.checkConnection"]!({
      id: "check-blocked",
      params: { providerId: "custom", modelId: "relay-model" },
    } as never);

    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: "/v1/messages",
      userAgent: expect.stringMatching(/^Anthropic\/JS /),
    });
    if (!("error" in outcome)) {
      expect(outcome.result).toEqual(expect.objectContaining({
        providerId: "custom",
        modelId: "relay-model",
        api: "anthropic-messages",
        ok: false,
        category: "blocked",
        suggestion: expect.stringContaining("User-Agent"),
      }));
      expect(JSON.stringify(outcome.result)).not.toContain("do-not-expose");
    }

    const compatible = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}`,
          api: "anthropic-messages",
          authHeader: false,
          headers: { "User-Agent": "PiDeck/0.1" },
          models: [{ id: "relay-model" }],
        },
      },
    });
    await putApiKey(compatible.credentialStore, "custom", "do-not-expose");
    const compatibleOutcome = await compatible.handlers["provider.checkConnection"]!({
      id: "check-compatible",
      params: { providerId: "custom", modelId: "relay-model" },
    } as never);

    expect("error" in compatibleOutcome ? compatibleOutcome.error.message : null).toBeNull();
    expect(requests[1]).toEqual({ url: "/v1/messages", userAgent: "PiDeck/0.1" });
    if (!("error" in compatibleOutcome)) {
      expect(compatibleOutcome.result).toEqual(expect.objectContaining({
        ok: true,
        category: "ok",
      }));
    }
  });

  it("detects and persists Bearer authentication after a native-auth 401", async () => {
    const authorizations: Array<string | undefined> = [];
    const apiServer = createServer((request, response) => {
      const authorization = typeof request.headers.authorization === "string"
        ? request.headers.authorization
        : undefined;
      authorizations.push(authorization);
      if (authorization === "Bearer do-not-expose") {
        writeAnthropicSuccess(response);
        return;
      }
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "Authorization header required" },
      }));
    });
    httpServers.push(apiServer);
    await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
    const address = apiServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const { layout, credentialStore, handlers } = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}`,
          api: "anthropic-messages",
          authHeader: false,
          headers: { "User-Agent": "PiDeck/0.1" },
          models: [{ id: "relay-model" }],
        },
      },
    });
    await putApiKey(credentialStore, "custom", "do-not-expose");

    const outcome = await handlers["provider.checkConnection"]!({
      id: "detect-bearer",
      params: { providerId: "custom", modelId: "relay-model" },
    } as never);
    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    expect(authorizations).toEqual([undefined, "Bearer do-not-expose"]);
    const persisted = JSON.parse(readFileSync(join(layout.agentDir, "models.json"), "utf8"));
    expect(persisted.providers.custom.authHeader).toBe(true);
    if (!("error" in outcome)) {
      expect(outcome.result).toEqual(expect.objectContaining({
        ok: true,
        category: "ok",
        message: expect.stringContaining("detected automatically"),
      }));
      expect(JSON.stringify(outcome.result)).not.toContain("do-not-expose");
    }

    const repeated = await handlers["provider.checkConnection"]!({
      id: "reuse-bearer",
      params: { providerId: "custom", modelId: "relay-model" },
    } as never);
    expect("error" in repeated ? repeated.error.message : null).toBeNull();
    expect(authorizations).toEqual([undefined, "Bearer do-not-expose", "Bearer do-not-expose"]);
  });

  it("does not persist detected authentication after Host shutdown cancellation", async () => {
    let markRetryStarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      markRetryStarted = resolve;
    });
    const apiServer = createServer((request, response) => {
      if (request.headers.authorization === "Bearer do-not-expose") {
        markRetryStarted();
        return;
      }
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "Authorization header required" },
      }));
    });
    httpServers.push(apiServer);
    await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
    const address = apiServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const fixture = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}`,
          api: "anthropic-messages",
          authHeader: false,
          headers: { "User-Agent": "PiDeck/0.1" },
          models: [{ id: "relay-model" }],
        },
      },
    });
    await putApiKey(fixture.credentialStore, "custom", "do-not-expose");
    vi.spyOn(fixture.server, "shutdown").mockResolvedValue();
    const pending = fixture.handlers["provider.checkConnection"]!({
      id: "detect-cancelled",
      params: { providerId: "custom", modelId: "relay-model" },
    } as never);
    await retryStarted;

    await fixture.server.requestShutdown("provider connection test");
    const outcome = await pending;
    expect("error" in outcome && outcome.error.code).toBe("HOST_SHUTTING_DOWN");
    const persisted = JSON.parse(
      readFileSync(join(fixture.layout.agentDir, "models.json"), "utf8"),
    );
    expect(persisted.providers.custom.authHeader).toBe(false);
    expect(fixture.server.graphOperations.getActive()).toBeNull();
    expect(fixture.server.serviceGraphLock.getOwner()).toBeNull();
  });

  it("tests the Coding Agent system role and honors OpenAI compatibility overrides", async () => {
    const requestRoles: string[][] = [];
    const apiServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role?: string }>;
        tools?: unknown[];
      };
      const roles = payload.messages?.map((message) => message.role ?? "") ?? [];
      requestRoles.push(roles);
      expect(payload.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({ name: "pideck_connection_test" }),
        }),
      ]));
      if (roles.includes("developer")) {
        response.writeHead(422, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          error: {
            message: "openai_error",
            type: "bad_response_status_code",
            code: "bad_response_status_code",
          },
        }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end([
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"relay-model","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"relay-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"));
    });
    httpServers.push(apiServer);
    await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
    const address = apiServer.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");

    const providerConfig = {
      name: "Custom",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: "openai-completions",
      authHeader: true,
      headers: { "User-Agent": "PiDeck/0.1" },
      models: [{ id: "relay-model", reasoning: true }],
    };
    const automatic = await setup({ providers: { custom: providerConfig } });
    await putApiKey(automatic.credentialStore, "custom", "do-not-expose");
    const automaticOutcome = await automatic.handlers["provider.checkConnection"]!({
      id: "check-developer-role",
      params: { providerId: "custom", modelId: "relay-model" },
    } as never);

    expect("error" in automaticOutcome ? automaticOutcome.error.message : null).toBeNull();
    expect(requestRoles[0]).toContain("developer");
    if (!("error" in automaticOutcome)) {
      expect(automaticOutcome.result).toEqual(expect.objectContaining({
        ok: false,
        category: "configuration",
        suggestion: expect.stringContaining("System role"),
      }));
    }

    const compatible = await setup({
      providers: {
        custom: {
          ...providerConfig,
          compat: { supportsDeveloperRole: false },
        },
      },
    });
    await putApiKey(compatible.credentialStore, "custom", "do-not-expose");
    const compatibleOutcome = await compatible.handlers["provider.checkConnection"]!({
      id: "check-system-role",
      params: { providerId: "custom", modelId: "relay-model" },
    } as never);

    expect("error" in compatibleOutcome ? compatibleOutcome.error.message : null).toBeNull();
    expect(requestRoles[1]).toContain("system");
    expect(requestRoles[1]).not.toContain("developer");
    if (!("error" in compatibleOutcome)) {
      expect(compatibleOutcome.result).toEqual(expect.objectContaining({
        ok: true,
        category: "ok",
      }));
    }
  });
});

describe("Provider login", () => {
  type LoginEvent = { loginId: string; providerId: string; event: Record<string, unknown> };

  function captureLoginEvents(server: PiHostServer): LoginEvent[] {
    const events: LoginEvent[] = [];
    const originalEmit = server.emit.bind(server);
    vi.spyOn(server, "emit").mockImplementation((name, payload) => {
      if (name === "provider.loginEvent") events.push(payload as LoginEvent);
      return originalEmit(name, payload);
    });
    return events;
  }

  it("lists builtin login-capable Providers and hides custom ones", async () => {
    const { handlers } = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: "https://relay.example/v1",
          api: "openai-completions",
          models: [{ id: "m" }],
        },
      },
    });
    const outcome = await handlers["provider.authStatus"]!({
      id: "auth-status",
      params: null,
    } as never);
    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    if ("error" in outcome) return;
    const providers = (outcome.result as {
      providers: Array<{
        providerId: string;
        supportsOauth: boolean;
        hasStoredCredential: boolean;
        enabled: boolean;
      }>;
    }).providers;
    const ids = providers.map((provider) => provider.providerId);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("github-copilot");
    expect(ids).not.toContain("custom");
    const anthropic = providers.find((provider) => provider.providerId === "anthropic")!;
    expect(anthropic.supportsOauth).toBe(true);
    expect(anthropic.hasStoredCredential).toBe(false);
    expect(anthropic.enabled).toBe(false);
  });

  it("bridges login prompts over events and enables the Provider on success", async () => {
    const { layout, server, handlers, modelRuntime } = await setup({ providers: {} });
    const events = captureLoginEvents(server);
    vi.spyOn(modelRuntime, "login").mockImplementation(async (_providerId, _type, interaction) => {
      interaction.notify({ type: "auth_url", url: "https://example.com/oauth" });
      const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
      expect(code).toBe("the-code");
      return { type: "api_key", key: "sk-from-login" };
    });

    const start = await handlers["provider.loginStart"]!({
      id: "login-start",
      params: { providerId: "anthropic", authType: "oauth" },
    } as never);
    expect("error" in start ? start.error.message : null).toBeNull();
    if ("error" in start) return;
    const loginId = (start.result as { loginId: string }).loginId;

    await vi.waitFor(() => {
      expect(events.some((entry) => entry.event.kind === "prompt")).toBe(true);
    });
    expect(events.some((entry) => entry.event.kind === "auth_url")).toBe(true);
    const prompt = events.find((entry) => entry.event.kind === "prompt")!.event.prompt as {
      promptId: string;
      kind: string;
    };
    expect(prompt.kind).toBe("manual_code");

    const respond = await handlers["provider.loginRespond"]!({
      id: "login-respond",
      params: { loginId, promptId: prompt.promptId, value: "the-code" },
    } as never);
    expect("error" in respond ? respond.error.message : null).toBeNull();

    await vi.waitFor(() => {
      expect(
        events.some((entry) => entry.event.kind === "done" && entry.event.ok === true),
      ).toBe(true);
    });
    const persisted = JSON.parse(readFileSync(join(layout.agentDir, "models.json"), "utf8"));
    expect(persisted.pideckEnabledProviders).toContain("anthropic");
  });

  it("cancels an active login flow and reports a failed done event", async () => {
    const { server, handlers, modelRuntime } = await setup({ providers: {} });
    const events = captureLoginEvents(server);
    vi.spyOn(modelRuntime, "login").mockImplementation(async (_providerId, _type, interaction) => {
      await interaction.prompt({ type: "text", message: "Waiting forever" });
      return { type: "api_key", key: "unused" };
    });

    const start = await handlers["provider.loginStart"]!({
      id: "login-start-cancel",
      params: { providerId: "openai", authType: "api_key" },
    } as never);
    expect("error" in start ? start.error.message : null).toBeNull();
    if ("error" in start) return;
    const loginId = (start.result as { loginId: string }).loginId;
    await vi.waitFor(() => {
      expect(events.some((entry) => entry.event.kind === "prompt")).toBe(true);
    });

    const cancel = await handlers["provider.loginCancel"]!({
      id: "login-cancel",
      params: { loginId },
    } as never);
    expect("error" in cancel).toBe(false);
    await vi.waitFor(() => {
      expect(
        events.some((entry) => entry.event.kind === "done" && entry.event.ok === false),
      ).toBe(true);
    });

    const followUp = await handlers["provider.loginStart"]!({
      id: "login-start-after-cancel",
      params: { providerId: "openai", authType: "api_key" },
    } as never);
    expect("error" in followUp ? followUp.error.message : null).toBeNull();
  });

  it("rejects a second concurrent login flow", async () => {
    const { handlers, modelRuntime } = await setup({ providers: {} });
    vi.spyOn(modelRuntime, "login").mockImplementation(async (_providerId, _type, interaction) => {
      await interaction.prompt({ type: "text", message: "hold" });
      return { type: "api_key", key: "unused" };
    });
    const first = await handlers["provider.loginStart"]!({
      id: "login-a",
      params: { providerId: "openai", authType: "api_key" },
    } as never);
    expect("error" in first).toBe(false);
    const second = await handlers["provider.loginStart"]!({
      id: "login-b",
      params: { providerId: "anthropic", authType: "oauth" },
    } as never);
    expect("error" in second && second.error.code).toBe("AGENT_BUSY");
    if (!("error" in first)) {
      await handlers["provider.loginCancel"]!({
        id: "login-a-cancel",
        params: { loginId: (first.result as { loginId: string }).loginId },
      } as never);
    }
  });

  it("toggles a builtin Provider in the enabled list by id", async () => {
    const { layout, handlers } = await setup({ providers: {} });
    const enable = await handlers["provider.setEnabled"]!({
      id: "enable-builtin",
      params: { providerId: "openai", enabled: true },
    } as never);
    expect("error" in enable ? enable.error.message : null).toBeNull();
    let persisted = JSON.parse(readFileSync(join(layout.agentDir, "models.json"), "utf8"));
    expect(persisted.pideckEnabledProviders).toContain("openai");

    const disable = await handlers["provider.setEnabled"]!({
      id: "disable-builtin",
      params: { providerId: "openai", enabled: false },
    } as never);
    expect("error" in disable ? disable.error.message : null).toBeNull();
    persisted = JSON.parse(readFileSync(join(layout.agentDir, "models.json"), "utf8"));
    expect(persisted.pideckEnabledProviders).not.toContain("openai");
  });

  it("logs out a stored credential and removes the Provider from the enabled list", async () => {
    const { layout, credentialStore, handlers } = await setup({
      pideckEnabledProviders: ["anthropic"],
      providers: {},
    });
    await putApiKey(credentialStore, "anthropic", "sk-test");
    const outcome = await handlers["provider.logout"]!({
      id: "logout-anthropic",
      params: { providerId: "anthropic" },
    } as never);
    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    expect(await credentialStore.readRaw("anthropic")).toBeUndefined();
    const persisted = JSON.parse(readFileSync(join(layout.agentDir, "models.json"), "utf8"));
    expect(persisted.pideckEnabledProviders ?? []).not.toContain("anthropic");
  });

  it("keeps builtin ids in the enabled filter once the list exists", async () => {
    const { layout } = await setup({ pideckEnabledProviders: ["anthropic"], providers: {} });
    expect(await getEnabledProviderIds(layout.agentDir, undefined, ["anthropic", "openai"]))
      .toEqual(["anthropic"]);
    expect(await getEnabledProviderIds(layout.agentDir, undefined, [])).toEqual([]);
  });
});

describe("Builtin provider models", () => {
  it("lists a builtin Provider's catalog with every model enabled by default", async () => {
    const { handlers } = await setup({ providers: {} });
    const outcome = await handlers["provider.builtinModels"]!({
      id: "builtin-models",
      params: { providerId: "anthropic" },
    } as never);
    expect("error" in outcome ? outcome.error.message : null).toBeNull();
    if ("error" in outcome) return;
    const { providerId, models } = outcome.result as {
      providerId: string;
      models: Array<{ id: string; name: string; enabled: boolean }>;
    };
    expect(providerId).toBe("anthropic");
    expect(models.length).toBeGreaterThan(1);
    expect(models.every((model) => model.enabled)).toBe(true);
  });

  it("stores an allow-list, filters the listing, and drops it on full re-selection", async () => {
    const { layout, handlers } = await setup({ providers: {} });
    const listed = await handlers["provider.builtinModels"]!({
      id: "builtin-models-before",
      params: { providerId: "anthropic" },
    } as never);
    if ("error" in listed) throw new Error(listed.error.message);
    const all = (listed.result as { models: Array<{ id: string }> }).models.map(
      (model) => model.id,
    );
    const keep = all.slice(0, 2);

    const set = await handlers["provider.setBuiltinModels"]!({
      id: "builtin-models-set",
      params: { providerId: "anthropic", modelIds: [...keep, "not-a-real-model"] },
    } as never);
    expect("error" in set ? set.error.message : null).toBeNull();
    if ("error" in set) return;
    const filtered = (set.result as { models: Array<{ id: string; enabled: boolean }> }).models;
    expect(filtered.filter((model) => model.enabled).map((model) => model.id).sort())
      .toEqual([...keep].sort());
    let persisted = JSON.parse(readFileSync(join(layout.agentDir, "models.json"), "utf8"));
    expect([...persisted.pideckProviderModels.anthropic].sort()).toEqual([...keep].sort());
    expect(await getProviderModelAllowLists(layout.agentDir)).toEqual({
      anthropic: expect.arrayContaining(keep),
    });

    const restore = await handlers["provider.setBuiltinModels"]!({
      id: "builtin-models-restore",
      params: { providerId: "anthropic", modelIds: all },
    } as never);
    expect("error" in restore ? restore.error.message : null).toBeNull();
    persisted = JSON.parse(readFileSync(join(layout.agentDir, "models.json"), "utf8"));
    expect(persisted.pideckProviderModels).toBeUndefined();
    expect(await getProviderModelAllowLists(layout.agentDir)).toBeUndefined();
  });

  it("rejects custom Providers and unknown ids", async () => {
    const { handlers } = await setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: "https://relay.example/v1",
          api: "openai-completions",
          models: [{ id: "m" }],
        },
      },
    });
    const custom = await handlers["provider.builtinModels"]!({
      id: "builtin-models-custom",
      params: { providerId: "custom" },
    } as never);
    expect("error" in custom && custom.error.code).toBe("INVALID_REQUEST");
    const unknown = await handlers["provider.setBuiltinModels"]!({
      id: "builtin-models-unknown",
      params: { providerId: "does-not-exist", modelIds: [] },
    } as never);
    expect("error" in unknown && unknown.error.code).toBe("MODEL_NOT_FOUND");
  });
});
