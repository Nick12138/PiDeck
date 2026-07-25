import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { ModelConfigHealth, ProviderDraft } from "@pideck/protocol";
import { createProviderHandlers } from "./provider-controller.js";
import { PiHostServer } from "./server.js";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";
import { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

const layouts: TempAgentLayout[] = [];
const httpServers: Server[] = [];

afterEach(async () => {
  for (const server of httpServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const layout of layouts.splice(0)) layout.cleanup();
});

function setup(initialModels: unknown) {
  const layout = createTempAgentLayout("pi-provider-test-");
  layouts.push(layout);
  writeFileSync(join(layout.agentDir, "models.json"), JSON.stringify(initialModels, null, 2));
  const authStorage = AuthStorage.create(join(layout.agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(layout.agentDir, "models.json"));
  let health: ModelConfigHealth = {
    state: modelRegistry.getError() ? "error" : "ok",
    source: "ModelRegistry.getError",
    ...(modelRegistry.getError() ? { message: modelRegistry.getError() } : {}),
  };
  const factory = new WorkspaceGraphFactory({
    agentDir: layout.agentDir,
    authStorage,
    modelRegistry,
    getModelConfigHealth: () => health,
    refreshModelHealth: () => {
      modelRegistry.refresh();
      health = {
        state: modelRegistry.getError() ? "error" : "ok",
        source: "ModelRegistry.getError",
        ...(modelRegistry.getError() ? { message: modelRegistry.getError() } : {}),
      };
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
    authStorage,
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
    const { layout, handlers } = setup({
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
    const { layout, authStorage, handlers } = setup({
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
    expect(authStorage.get("custom")).toEqual({ type: "api_key", key: "secret-key" });
    if (!("error" in outcome)) {
      expect((outcome.result as { provider: { auth: { configured: boolean } } }).provider.auth.configured).toBe(true);
    }
  });

  it("chooses the native authentication default for a new Anthropic Provider", async () => {
    const { layout, handlers } = setup({ providers: {} });
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

    const { handlers } = setup({
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

    const { authStorage, handlers } = setup({
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
    authStorage.set("custom", { type: "api_key", key: "stored-secret" });
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

    const { handlers } = setup({
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

    const { handlers } = setup({
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

    const { authStorage, handlers } = setup({
      providers: {
        custom: {
          name: "Custom",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          models: [],
        },
      },
    });
    authStorage.set("custom", { type: "api_key", key: "do-not-expose" });
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

    const { handlers } = setup({
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

    const { handlers } = setup({
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

    const { handlers } = setup({
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

    const { authStorage, handlers } = setup({
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
    authStorage.set("custom", { type: "api_key", key: "do-not-expose" });
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

    const compatible = setup({
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
    compatible.authStorage.set("custom", { type: "api_key", key: "do-not-expose" });
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

    const { layout, authStorage, handlers } = setup({
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
    authStorage.set("custom", { type: "api_key", key: "do-not-expose" });

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
    const automatic = setup({ providers: { custom: providerConfig } });
    automatic.authStorage.set("custom", { type: "api_key", key: "do-not-expose" });
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

    const compatible = setup({
      providers: {
        custom: {
          ...providerConfig,
          compat: { supportsDeveloperRole: false },
        },
      },
    });
    compatible.authStorage.set("custom", { type: "api_key", key: "do-not-expose" });
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
