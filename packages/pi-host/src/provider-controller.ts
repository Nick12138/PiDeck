import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { completeSimple, type Api, type Context, type Model } from "@earendil-works/pi-ai/compat";
import {
  createHostError,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  detectModelThinking,
  type DiscoveredProviderModel,
  type HostError,
  type HostIdentity,
  type ProviderApi,
  type ProviderConnectionCategory,
  type ProviderConnectionResult,
  type ProviderCompatibility,
  type ProviderCompatibilityDraft,
  type ProviderDraft,
  type ProviderModelConfig,
  type ProviderSnapshot,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from "@pideck/protocol";
import type { MethodHandler, PiHostServer } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { rebindCurrentSessionModel } from "./model-thinking.js";
import { withRegisteredGraphMutation } from "./registered-graph-mutation.js";
import { withStableGraphRead } from "./stable-graph-read.js";

type JsonObject = Record<string, unknown>;
type ModelsConfig = { root: JsonObject; providers: JsonObject; original: string | null };
type ProviderFetchCapture =
  | {
      snapshot: {
        original: string | null;
        provider: ProviderSnapshot;
        apiKey: string | undefined;
      };
    }
  | { error: HostError };
type ProviderConnectionCapture =
  | {
      snapshot: {
        original: string | null;
        provider: ProviderSnapshot;
        model: Model<Api>;
        auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
      };
    }
  | { error: HostError };
const ENABLED_PROVIDERS_KEY = "pideckEnabledProviders";
const LEGACY_ACTIVE_PROVIDER_KEY = "pideckActiveProvider";

const PROVIDER_APIS = new Set<ProviderApi>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

function defaultAuthHeader(api: ProviderApi): boolean {
  return api === "openai-completions" || api === "openai-responses";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function normalizeModel(value: unknown): ProviderModelConfig | null {
  if (!isObject(value) || typeof value.id !== "string" || !value.id.trim()) return null;
  const id = value.id.trim();
  const input = Array.isArray(value.input)
    ? value.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
    : [];
  const thinkingLevelMap = isObject(value.thinkingLevelMap)
    ? (Object.fromEntries(
        Object.entries(value.thinkingLevelMap).filter(
          (entry): entry is [ThinkingLevel, string | null] =>
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(entry[0]) &&
            (entry[1] === null || typeof entry[1] === "string"),
        ),
      ) as ThinkingLevelMap)
    : undefined;
  return {
    id,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : id,
    reasoning: value.reasoning === true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: input.length > 0 ? [...new Set(input)] : ["text"],
    contextWindow:
      typeof value.contextWindow === "number" && Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0
        ? value.contextWindow
        : DEFAULT_MODEL_CONTEXT_WINDOW,
    maxTokens:
      typeof value.maxTokens === "number" && Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0
        ? value.maxTokens
        : DEFAULT_MODEL_MAX_TOKENS,
  };
}

const MANAGED_COMPAT_KEYS = [
  "supportsDeveloperRole",
  "supportsReasoningEffort",
] as const;

function normalizeCompatibilityDraft(value: unknown): ProviderCompatibilityDraft | undefined {
  if (!isObject(value)) return undefined;
  const compat: ProviderCompatibilityDraft = {};
  for (const key of MANAGED_COMPAT_KEYS) {
    const item = value[key];
    if (typeof item === "boolean" || item === null) compat[key] = item;
  }
  return Object.keys(compat).length > 0 ? compat : undefined;
}

function compatibilitySnapshot(value: unknown): ProviderCompatibility | undefined {
  if (!isObject(value)) return undefined;
  const compat: ProviderCompatibility = {};
  for (const key of MANAGED_COMPAT_KEYS) {
    if (typeof value[key] === "boolean") compat[key] = value[key];
  }
  return Object.keys(compat).length > 0 ? compat : undefined;
}

function normalizeDraft(input: ProviderDraft): ProviderDraft {
  const models = new Map<string, ProviderModelConfig>();
  for (const item of input.models) {
    const model = normalizeModel(item);
    if (model) models.set(model.id, model);
  }
  const compat = normalizeCompatibilityDraft(input.compat);
  return {
    id: input.id.trim(),
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
    ...(input.modelsUrl?.trim() ? { modelsUrl: input.modelsUrl.trim() } : {}),
    api: input.api,
    headers: Object.fromEntries(
      Object.entries(input.headers)
        .map(([key, value]) => [key.trim(), value.trim()] as const)
        .filter(([key]) => key.length > 0),
    ),
    ...(compat ? { compat } : {}),
    models: [...models.values()],
  };
}

function validateDraft(input: ProviderDraft): HostError | null {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(input.id)) {
    return createHostError(
      "INVALID_REQUEST",
      "Provider ID may only contain letters, numbers, dots, underscores, and hyphens",
    );
  }
  if (!input.name) return createHostError("INVALID_REQUEST", "Provider name is required");
  if (!PROVIDER_APIS.has(input.api)) {
    return createHostError("INVALID_REQUEST", `Unsupported Provider API: ${input.api}`);
  }
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    return createHostError("INVALID_REQUEST", "Base URL must be a valid HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return createHostError("INVALID_REQUEST", "Base URL must use HTTP or HTTPS");
  }
  if (input.modelsUrl) {
    try {
      const modelsUrl = new URL(input.modelsUrl);
      if (modelsUrl.protocol !== "http:" && modelsUrl.protocol !== "https:") throw new Error();
    } catch {
      return createHostError("INVALID_REQUEST", "Models URL must be a valid HTTP or HTTPS URL");
    }
  }
  return null;
}

async function readModelsConfig(path: string): Promise<ModelsConfig> {
  let original: string | null = null;
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (original === null || !original.trim()) {
    const providers: JsonObject = {};
    return { root: { providers }, providers, original };
  }
  const parsed = JSON.parse(original) as unknown;
  if (!isObject(parsed)) throw new Error("models.json root must be an object");
  const providers = parsed.providers;
  if (providers === undefined) {
    const next: JsonObject = {};
    parsed.providers = next;
    return { root: parsed, providers: next, original };
  }
  if (!isObject(providers)) throw new Error("models.json providers must be an object");
  return { root: parsed, providers, original };
}

function resolveEnabledProviders(config: ModelsConfig, preferredProvider?: string): string[] {
  const providerIds = Object.entries(config.providers)
    .filter((entry): entry is [string, JsonObject] => isObject(entry[1]))
    .map(([id]) => id);
  if (providerIds.length === 0) return [];
  const configured = config.root[ENABLED_PROVIDERS_KEY];
  if (Array.isArray(configured)) {
    return [...new Set(configured.filter((id): id is string => typeof id === "string" && providerIds.includes(id)))];
  }
  const legacyActive = config.root[LEGACY_ACTIVE_PROVIDER_KEY];
  if (typeof legacyActive === "string" && providerIds.includes(legacyActive)) return [legacyActive];
  if (preferredProvider && providerIds.includes(preferredProvider)) return [preferredProvider];
  const fallback = providerIds.find((id) => {
    const provider = config.providers[id];
    return isObject(provider) && Array.isArray(provider.models) && provider.models.length > 0;
  }) ?? providerIds[0];
  return fallback ? [fallback] : [];
}

export async function getEnabledProviderIds(
  agentDir: string,
  preferredProvider?: string,
): Promise<string[] | undefined> {
  try {
    const config = await readModelsConfig(join(agentDir, "models.json"));
    if (!Object.values(config.providers).some(isObject)) return undefined;
    return resolveEnabledProviders(config, preferredProvider);
  } catch {
    return undefined;
  }
}

function providerSnapshot(
  id: string,
  raw: JsonObject,
  factory: WorkspaceGraphFactory,
  enabled: boolean,
): ProviderSnapshot {
  const api =
    typeof raw.api === "string" && PROVIDER_APIS.has(raw.api as ProviderApi)
      ? (raw.api as ProviderApi)
      : "openai-completions";
  const models = Array.isArray(raw.models)
    ? raw.models.map(normalizeModel).filter((model): model is ProviderModelConfig => model !== null)
    : [];
  const compat = compatibilitySnapshot(raw.compat);
  return {
    id,
    enabled,
    name:
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : factory.deps.modelRegistry.getProviderDisplayName(id),
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    ...(typeof raw.modelsUrl === "string" && raw.modelsUrl.trim()
      ? { modelsUrl: raw.modelsUrl.trim() }
      : {}),
    api,
    authHeader: raw.authHeader === true,
    headers: stringRecord(raw.headers),
    ...(compat ? { compat } : {}),
    models,
    auth: factory.deps.modelRegistry.getProviderAuthStatus(id),
  };
}

function mergeProvider(existing: JsonObject, draft: ProviderDraft): JsonObject {
  const existingModels = new Map<string, JsonObject>();
  if (Array.isArray(existing.models)) {
    for (const item of existing.models) {
      if (isObject(item) && typeof item.id === "string") existingModels.set(item.id, item);
    }
  }
  const models = draft.models.map((model) => {
    const next = {
      ...(existingModels.get(model.id) ?? {}),
      ...model,
    };
    if (model.thinkingLevelMap === undefined) delete next.thinkingLevelMap;
    return next;
  });
  const merged: JsonObject = {
    ...existing,
    name: draft.name,
    baseUrl: draft.baseUrl,
    ...(draft.modelsUrl ? { modelsUrl: draft.modelsUrl } : {}),
    api: draft.api,
    authHeader:
      existing.api === draft.api && typeof existing.authHeader === "boolean"
        ? existing.authHeader
        : defaultAuthHeader(draft.api),
    headers: draft.headers,
    models,
  };
  if (!draft.modelsUrl) delete merged.modelsUrl;
  if (draft.compat) {
    const compat: JsonObject = isObject(existing.compat) ? { ...existing.compat } : {};
    for (const key of MANAGED_COMPAT_KEYS) {
      const value = draft.compat[key];
      if (value === null) delete compat[key];
      else if (typeof value === "boolean") compat[key] = value;
    }
    if (Object.keys(compat).length > 0) merged.compat = compat;
    else delete merged.compat;
  }
  return merged;
}

/**
 * Validate a candidate models.json in complete isolation.
 *
 * The runtime gets the candidate file, a throwaway models store, an empty
 * in-memory credential store, and no network. It must not observe the real
 * auth.json or models-store.json, and must not disturb the production runtime
 * or the current session's model.
 */
async function validateCandidateModelsConfig(tempPath: string): Promise<void> {
  const storePath = join(dirname(tempPath), `.models-store-${randomUUID()}.tmp`);
  try {
    const candidateRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: tempPath,
      modelsStorePath: storePath,
      allowModelNetwork: false,
    });
    const validationError = candidateRuntime.getError();
    if (validationError) throw new Error(validationError);
  } finally {
    await unlink(storePath).catch(() => undefined);
  }
}

async function commitModelsConfig(
  path: string,
  root: JsonObject,
  _factory: WorkspaceGraphFactory,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const candidate = JSON.stringify(root, null, 2) + "\n";
  const tempPath = join(dirname(path), `.models-${randomUUID()}.tmp`);
  const backupPath = join(dirname(path), `models-${Date.now()}-${randomUUID().slice(0, 8)}.bak`);
  await writeFile(tempPath, candidate, { encoding: "utf8", mode: 0o600 });
  try {
    await validateCandidateModelsConfig(tempPath);
    try {
      await copyFile(path, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(tempPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const displacedPath = join(dirname(path), `.models-${randomUUID()}.old`);
      await rename(path, displacedPath);
      try {
        await rename(tempPath, path);
        await unlink(displacedPath).catch(() => undefined);
      } catch (replaceError) {
        await rename(displacedPath, path).catch(() => undefined);
        throw replaceError;
      }
    }
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function restoreModelsConfig(path: string, original: string | null): Promise<void> {
  if (original === null) {
    await unlink(path).catch(() => undefined);
    return;
  }
  await writeFile(path, original, { encoding: "utf8", mode: 0o600 });
}

function currentModelConflict(
  factory: WorkspaceGraphFactory,
  originalId: string,
  draft?: ProviderDraft,
  managesModelList = true,
): HostError | null {
  const current = factory.getGraph()?.agentSession?.model;
  if (!current || current.provider !== originalId) return null;
  if (
    !draft ||
    draft.id !== originalId ||
    (managesModelList && !draft.models.some((model) => model.id === current.id))
  ) {
    return createHostError(
      "AGENT_BUSY",
      `The current session uses ${current.provider}/${current.id}. Select another model before changing its Provider entry.`,
      { retryable: true },
    );
  }
  return null;
}

async function refreshRegistry(factory: WorkspaceGraphFactory, rebindCurrentModel = false): Promise<void> {
  await Promise.resolve(factory.deps.refreshModelHealth());
  factory.onModelHealthChanged?.();
  if (!rebindCurrentModel) return;
  const graph = factory.getGraph();
  if (!graph?.agentSession || !graph.agentSession.isIdle) return;
  rebindCurrentSessionModel(graph.agentSession, factory.deps.modelRegistry);
}

async function invalidateRetainedRuntimes(factory: WorkspaceGraphFactory): Promise<void> {
  await factory.invalidateRetainedRuntimeCaches?.();
}

async function alignCurrentSessionModel(
  factory: WorkspaceGraphFactory,
  targetProvider: string | undefined,
  preferredModelIds: string[] = [],
): Promise<void> {
  if (!targetProvider) return;
  const session = factory.getGraph()?.agentSession;
  if (!session?.isIdle || session.model?.provider === targetProvider) return;
  const registry = factory.deps.modelRegistry;
  const model = preferredModelIds
    .map((id) => registry.find(targetProvider, id))
    .find((item) => item !== undefined)
    ?? registry.getAll().find((item) => item.provider === targetProvider);
  if (model) await session.setModel(model);
}

const ANTHROPIC_COMPAT_PATH_SUFFIXES = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude",
] as const;

function modelCatalogUrls(baseUrl: string, modelsUrl?: string): URL[] {
  if (modelsUrl) return [new URL(modelsUrl)];
  const base = new URL(baseUrl);
  const pathname = base.pathname.replace(/\/+$/, "");
  const paths: string[] = [];
  const add = (path: string) => {
    const normalized = path.replace(/\/{2,}/g, "/") || "/";
    if (!paths.includes(normalized)) paths.push(normalized);
  };
  const versionMatch = pathname.match(/^(.*)\/v(\d+)$/i);
  const compatSuffix = ANTHROPIC_COMPAT_PATH_SUFFIXES.find((suffix) =>
    pathname.toLowerCase().endsWith(suffix),
  );
  if (!pathname) {
    add("/v1/models");
    add("/models");
  } else if (versionMatch) {
    const prefix = versionMatch[1];
    add(`${pathname}/models`);
    if (versionMatch[2] !== "1") add(`${prefix}/v1/models`);
    add(`${prefix}/models`);
  } else if (compatSuffix) {
    const prefix = pathname.slice(0, -compatSuffix.length);
    add(`${prefix}/v1/models`);
    add(`${prefix}/models`);
  } else {
    add(`${pathname}/models`);
    add(`${pathname}/v1/models`);
  }
  return paths.map((path) => {
    const url = new URL(base);
    url.pathname = path;
    url.search = "";
    url.hash = "";
    return url;
  });
}

function catalogEndpointLabel(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function redactedProviderMessage(
  payload: unknown,
  sensitiveValues: string[],
): string | undefined {
  if (!isObject(payload)) return undefined;
  const nestedError = isObject(payload.error) ? payload.error.message : payload.error;
  const raw = [nestedError, payload.message, payload.detail]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!raw) return undefined;
  let message = raw.replace(/\s+/g, " ").trim();
  for (const value of sensitiveValues) {
    if (value) message = message.replaceAll(value, "[redacted]");
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function redactedProviderText(raw: string, sensitiveValues: string[]): string {
  let message = raw.replace(/\s+/g, " ").trim();
  for (const value of sensitiveValues) {
    if (value) message = message.replaceAll(value, "[redacted]");
  }
  return message.length > 320 ? `${message.slice(0, 317)}...` : message;
}

function providerSensitiveValues(
  apiKey: string | undefined,
  headers: Record<string, string>,
): string[] {
  const headerValues = Object.entries(headers)
    .filter(([name, value]) =>
      value.length >= 6 || /authorization|api.?key|token|secret|cookie/i.test(name),
    )
    .map(([, value]) => value);
  return [...new Set([apiKey, ...headerValues].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  ))];
}

type CatalogResponse = {
  items?: unknown[];
  error?: string;
  retryAlternatePath: boolean;
};

async function fetchModelCatalog(
  url: URL,
  headers: Headers,
  sensitiveValues: string[],
  signal: AbortSignal,
): Promise<CatalogResponse> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    const kind = response.headers.get("content-type")?.includes("text/html") || /^\s*</.test(text)
      ? "HTML instead of JSON"
      : "invalid JSON";
    return {
      error: `Provider model endpoint ${catalogEndpointLabel(url)} returned ${kind}`,
      retryAlternatePath: response.ok || response.status === 404 || response.status === 405,
    };
  }

  const detail = redactedProviderMessage(payload, sensitiveValues);
  if (!response.ok) {
    return {
      error: `Provider model endpoint ${catalogEndpointLabel(url)} returned ${response.status} ${response.statusText}${
        detail ? `: ${detail}` : ""
      }`,
      retryAlternatePath: response.status === 404 || response.status === 405,
    };
  }

  const items = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.data)
      ? payload.data
      : isObject(payload) && Array.isArray(payload.models)
        ? payload.models
        : undefined;
  if (!items) {
    return {
      error: `Provider model endpoint ${catalogEndpointLabel(url)} returned JSON without a model list${
        detail ? `: ${detail}` : ""
      }`,
      retryAlternatePath: true,
    };
  }
  return { items, retryAlternatePath: false };
}

async function discoverModels(
  provider: ProviderSnapshot,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<DiscoveredProviderModel[]> {
  const headers = new Headers(provider.headers);
  headers.set("Accept", "application/json");
  if (apiKey) {
    if (provider.authHeader) headers.set("Authorization", `Bearer ${apiKey}`);
    if (provider.api === "anthropic-messages") {
      headers.set("x-api-key", apiKey);
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    } else if (provider.api !== "google-generative-ai" && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
  }
  const urls = modelCatalogUrls(provider.baseUrl, provider.modelsUrl);
  const sensitiveValues = providerSensitiveValues(apiKey, provider.headers);
  const attempted: string[] = [];
  let lastError = "Provider returned an invalid model catalog";
  let items: unknown[] | undefined;
  for (const url of urls) {
    if (apiKey && provider.api === "google-generative-ai") url.searchParams.set("key", apiKey);
    attempted.push(catalogEndpointLabel(url));
    let result: CatalogResponse;
    try {
      result = await fetchModelCatalog(url, headers, sensitiveValues, signal);
    } catch (error) {
      signal.throwIfAborted();
      const raw = error instanceof Error ? error.message : String(error);
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      result = {
        error: `Could not reach Provider model endpoint ${catalogEndpointLabel(url)}: ${
          timeout ? "request timed out" : redactedProviderText(raw, sensitiveValues)
        }`,
        retryAlternatePath: true,
      };
    }
    if (result.items) {
      items = result.items;
      break;
    }
    if (result.error) lastError = result.error;
    if (!result.retryAlternatePath) break;
  }
  if (!items) {
    throw new Error(`${lastError}. Check the Base URL; tried ${attempted.join(" or ")}`);
  }
  const enabled = new Map(provider.models.map((model) => [model.id, model]));
  const discovered = new Map<string, DiscoveredProviderModel>();
  for (const item of items) {
    if (!isObject(item)) continue;
    const rawId = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "";
    const id = rawId.replace(/^models\//, "").trim();
    if (!id) continue;
    const existing = enabled.get(id);
    const detected = detectModelThinking(id, item);
    const useDetectedMap =
      existing?.thinkingLevelMap === undefined && existing?.reasoning === true && detected.reasoning;
    const thinkingLevelMap = existing?.thinkingLevelMap ??
      (existing === undefined || useDetectedMap ? detected.thinkingLevelMap : undefined);
    const reasoning = existing?.reasoning ?? detected.reasoning;
    const thinkingSource = existing?.thinkingLevelMap
      ? "configured"
      : useDetectedMap || existing === undefined
        ? detected.source
        : "configured";
    discovered.set(id, {
      id,
      name: existing?.name ?? (typeof item.displayName === "string" ? item.displayName : id),
      reasoning,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      input: existing?.input ?? ["text"],
      contextWindow: existing?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
      maxTokens: existing?.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
      enabled: enabled.has(id),
      thinkingSource,
    });
  }
  for (const model of provider.models) {
    if (!discovered.has(model.id)) {
      const detected = detectModelThinking(model.id);
      const thinkingLevelMap = model.thinkingLevelMap ??
        (model.reasoning && detected.reasoning ? detected.thinkingLevelMap : undefined);
      discovered.set(model.id, {
        ...model,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        enabled: true,
        thinkingSource: model.thinkingLevelMap
          ? "configured"
          : model.reasoning && detected.reasoning
            ? detected.source
            : "configured",
      });
    }
  }
  return [...discovered.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function headersForAuthMode(
  provider: ProviderSnapshot,
  resolvedHeaders: Record<string, string> | undefined,
  apiKey: string | undefined,
  authHeader: boolean,
): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(resolvedHeaders ?? {}).filter(([key]) => key.toLowerCase() !== "authorization"),
  );
  const explicitAuthorization = Object.entries(provider.headers)
    .find(([key]) => key.toLowerCase() === "authorization");
  if (explicitAuthorization) headers[explicitAuthorization[0]] = explicitAuthorization[1];
  else if (authHeader && apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function classifyConnectionFailure(
  raw: string,
  provider: ProviderSnapshot,
  sensitiveValues: string[],
): Pick<ProviderConnectionResult, "category" | "message" | "suggestion"> {
  const message = redactedProviderText(raw || "Provider request failed", sensitiveValues);
  const lower = message.toLowerCase();
  let category: ProviderConnectionCategory = "provider";
  let suggestion: string | undefined;

  if (/\b401\b|unauthorized|(?:invalid|missing|no) api.?key|api.?key.*(?:not found|required)|authentication|authentication_error/.test(lower)) {
    category = "authentication";
    suggestion = "Check the API key and the Provider's authentication header settings.";
  } else if (/\b403\b|forbidden|blocked|cloudflare|\bwaf\b|access denied/.test(lower)) {
    category = "blocked";
    suggestion = provider.api === "anthropic-messages" && !hasHeader(provider.headers, "user-agent")
      ? "This relay may block the Anthropic SDK fingerprint. Set User-Agent to PiDeck/0.1 and retry."
      : "The relay or its WAF rejected the request. Check IP policy, headers, and User-Agent rules.";
  } else if (/\b429\b|rate.?limit|too many requests|quota/.test(lower)) {
    category = "rate_limit";
    suggestion = "The endpoint is reachable but rate-limited. Retry later or check the account quota.";
  } else if (/\b404\b|not found|unknown endpoint|no route/.test(lower)) {
    category = "not_found";
    suggestion = `Check that the Base URL and ${provider.api} protocol point to the same API.`;
  } else if (/timeout|timed out|aborted|deadline exceeded/.test(lower)) {
    category = "timeout";
    suggestion = "The generation request did not complete within 15 seconds. Check relay latency and routing.";
  } else if (/fetch failed|enotfound|econnrefused|eai_again|socket|network|connection reset/.test(lower)) {
    category = "network";
    suggestion = "Check DNS, proxy settings, TLS, and whether the endpoint is reachable from this machine.";
  } else if (/unexpected token|<!doctype|<html|invalid json|parse|stream ended|protocol/.test(lower)) {
    category = "protocol";
    suggestion = `The response did not match ${provider.api}. Check the protocol selection and Base URL.`;
  } else if (/\b400\b|\b422\b|bad request|invalid_request|model.*required|unknown model/.test(lower)) {
    category = "configuration";
    suggestion = provider.api === "openai-completions"
      ? "The relay rejected the Coding Agent request shape. Try System role and omit reasoning_effort in OpenAI compatibility."
      : "Check the model ID, protocol selection, and provider-specific request requirements.";
  }
  return { category, message, ...(suggestion ? { suggestion } : {}) };
}

async function checkProviderConnection(
  provider: ProviderSnapshot,
  model: Model<Api>,
  auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>,
  signal: AbortSignal,
  authHeaderOverride?: boolean,
): Promise<ProviderConnectionResult> {
  const startedAt = Date.now();
  signal.throwIfAborted();
  if (!auth.ok) {
    const failure = classifyConnectionFailure(auth.error, provider, []);
    return {
      providerId: provider.id,
      modelId: model.id,
      api: provider.api,
      ok: false,
      latencyMs: Date.now() - startedAt,
      ...failure,
    };
  }
  const headers = authHeaderOverride === undefined
    ? auth.headers
    : headersForAuthMode(provider, auth.headers, auth.apiKey, authHeaderOverride);
  const sensitiveValues = providerSensitiveValues(auth.apiKey, headers ?? {});
  const context: Context = {
    systemPrompt: "You are validating a coding assistant Provider.",
    messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
    tools: [{
      name: "pideck_connection_test",
      description: "Return a diagnostic label for the Provider connection test.",
      parameters: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
        additionalProperties: false,
      } as never,
    }],
  };
  try {
    const response = await completeSimple(model, context, {
      apiKey: auth.apiKey,
      headers,
      env: auth.env,
      maxTokens: 4,
      ...(model.reasoning ? { reasoning: "minimal" as const } : {}),
      signal,
      timeoutMs: 15_000,
      maxRetries: 0,
      maxRetryDelayMs: 0,
    });
    signal.throwIfAborted();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      const failure = classifyConnectionFailure(
        response.errorMessage ?? `Generation ${response.stopReason}`,
        provider,
        sensitiveValues,
      );
      return {
        providerId: provider.id,
        modelId: model.id,
        api: provider.api,
        ok: false,
        latencyMs: Date.now() - startedAt,
        ...failure,
      };
    }
    return {
      providerId: provider.id,
      modelId: model.id,
      api: provider.api,
      ok: true,
      latencyMs: Date.now() - startedAt,
      category: "ok",
      message: `Generation succeeded with ${provider.api}.`,
    };
  } catch (error) {
    signal.throwIfAborted();
    const failure = classifyConnectionFailure(
      error instanceof Error ? error.message : String(error),
      provider,
      sensitiveValues,
    );
    return {
      providerId: provider.id,
      modelId: model.id,
      api: provider.api,
      ok: false,
      latencyMs: Date.now() - startedAt,
      ...failure,
    };
  }
}

async function persistDetectedAuthHeader(
  modelsPath: string,
  providerId: string,
  authHeader: boolean,
  expectedOriginal: string | null,
  expectedIdentity: HostIdentity,
  requestId: string,
  factory: WorkspaceGraphFactory,
): Promise<{ error: HostError } | { identity: HostIdentity }> {
  if (factory.hasBusySessions()) {
    throw new Error("Stop running sessions before applying detected Provider authentication");
  }
  const server = factory.getServer();
  if (!server) throw new Error("Server not bound");
  return withRegisteredGraphMutation({
    server,
    operationKind: "provider.mutation",
    requestId,
    run: async ({ signal }) => {
      const config = await readModelsConfig(modelsPath);
      const identity = server.getIdentity();
      if (
        config.original !== expectedOriginal ||
        !hostIdentitiesEqual(identity, expectedIdentity)
      ) {
        return {
          error: createHostError(
            "STALE_REVISION",
            "Provider configuration changed during connection testing",
            { retryable: true },
          ),
        };
      }
      const raw = config.providers[providerId];
      if (!isObject(raw)) throw new Error(`Provider not found: ${providerId}`);
      if (raw.authHeader === authHeader) return { identity };
      await invalidateRetainedRuntimes(factory);
      signal.throwIfAborted();
      raw.authHeader = authHeader;
      await commitModelsConfig(modelsPath, config.root, factory);
      try {
        await refreshRegistry(factory, true);
      } catch (error) {
        await restoreModelsConfig(modelsPath, config.original);
        await refreshRegistry(factory, true);
        throw error;
      }
      return { identity };
    },
  });
}

async function readModelsOriginalUnderLock(
  server: PiHostServer,
  modelsPath: string,
  requestId: string,
) {
  return withStableGraphRead({
    requestId,
    identity: server.identity,
    serviceGraphLock: server.serviceGraphLock,
    run: async () => (await readModelsConfig(modelsPath)).original,
  });
}

function hostShuttingDownError(): HostError {
  return createHostError("HOST_SHUTTING_DOWN", "Host is shutting down", {
    retryable: true,
  });
}

function hostIdentitiesEqual(left: HostIdentity, right: HostIdentity): boolean {
  return left.hostInstanceId === right.hostInstanceId &&
    left.workspaceId === right.workspaceId &&
    left.workspaceRevision === right.workspaceRevision &&
    left.sessionId === right.sessionId &&
    left.sessionRevision === right.sessionRevision &&
    left.packageRevision === right.packageRevision;
}

function providerReadStaleError(args: {
  capturedIdentity: HostIdentity;
  validatedIdentity: HostIdentity;
  capturedOriginal: string | null;
  validatedOriginal: string | null;
  message: string;
}): HostError | null {
  if (
    hostIdentitiesEqual(args.capturedIdentity, args.validatedIdentity) &&
    args.capturedOriginal === args.validatedOriginal
  ) {
    return null;
  }
  return createHostError("STALE_REVISION", args.message, { retryable: true });
}

export function createProviderHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<
  | "provider.list"
  | "provider.setEnabled"
  | "provider.save"
  | "provider.remove"
  | "provider.fetchModels"
  | "provider.checkConnection",
  MethodHandler
>> {
  const modelsPath = join(factory.deps.agentDir, "models.json");

  return {
    "provider.list": async () => {
      try {
        await refreshRegistry(factory);
        const config = await readModelsConfig(modelsPath);
        const enabledProviders = new Set(resolveEnabledProviders(
          config,
          factory.getGraph()?.agentSession?.model?.provider,
        ));
        const providers = Object.entries(config.providers)
          .filter((entry): entry is [string, JsonObject] => isObject(entry[1]))
          .map(([id, raw]) => providerSnapshot(id, raw, factory, enabledProviders.has(id)))
          .sort((left, right) => left.name.localeCompare(right.name));
        return { result: { providers } };
      } catch (error) {
        return {
          error: createHostError(
            "SETTINGS_READ_FAILED",
            error instanceof Error ? error.message : "Could not read Provider configuration",
          ),
        };
      }
    },

    "provider.setEnabled": async (ctx) => {
      const { providerId, enabled } = ctx.params as { providerId: string; enabled: boolean };
      if (factory.hasBusySessions()) {
        return {
          error: createHostError("AGENT_BUSY", "Stop running sessions before changing enabled Providers", {
            retryable: true,
          }),
        };
      }
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      return withRegisteredGraphMutation({
        server,
        operationKind: "provider.mutation",
        requestId: ctx.id,
        run: async ({ signal }) => {
          try {
            if (factory.hasBusySessions()) {
              return {
                error: createHostError("AGENT_BUSY", "Stop running sessions before changing enabled Providers", {
                  retryable: true,
                }),
              };
            }
            const config = await readModelsConfig(modelsPath);
            const raw = config.providers[providerId];
            if (!isObject(raw)) {
              return { error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`) };
            }
            await invalidateRetainedRuntimes(factory);
            signal.throwIfAborted();
            const nextEnabled = new Set(resolveEnabledProviders(
              config,
              factory.getGraph()?.agentSession?.model?.provider,
            ));
            if (enabled) nextEnabled.add(providerId);
            else nextEnabled.delete(providerId);
            config.root[ENABLED_PROVIDERS_KEY] = [...nextEnabled];
            delete config.root[LEGACY_ACTIVE_PROVIDER_KEY];
            await commitModelsConfig(modelsPath, config.root, factory);
            try {
              await refreshRegistry(factory, true);
              const currentProvider = factory.getGraph()?.agentSession?.model?.provider;
              if (!currentProvider || !nextEnabled.has(currentProvider)) {
                const targetProvider = enabled ? providerId : [...nextEnabled][0];
                const targetRaw = targetProvider ? config.providers[targetProvider] : undefined;
                const modelIds = isObject(targetRaw) && Array.isArray(targetRaw.models)
                  ? targetRaw.models
                      .filter((model): model is JsonObject => isObject(model))
                      .map((model) => model.id)
                      .filter((id): id is string => typeof id === "string")
                  : [];
                await alignCurrentSessionModel(factory, targetProvider, modelIds);
              }
            } catch (error) {
              await restoreModelsConfig(modelsPath, config.original);
              await refreshRegistry(factory, true);
              throw error;
            }
            return { result: { providerId, enabled } };
          } catch (error) {
            return {
              error: createHostError(
                "SETTINGS_WRITE_FAILED",
                error instanceof Error ? error.message : "Could not update enabled Providers",
              ),
            };
          }
        },
      });
    },

    "provider.save": async (ctx) => {
      const params = ctx.params as {
        originalId?: string;
        provider: ProviderDraft;
        apiKey?: string;
        clearApiKey?: boolean;
      };
      const draft = normalizeDraft(params.provider);
      const originalId = params.originalId?.trim() || draft.id;
      const invalid = validateDraft(draft);
      if (invalid) return { error: invalid };
      if (factory.hasBusySessions()) {
        return {
          error: createHostError("AGENT_BUSY", "Stop running sessions before changing Provider configuration", {
            retryable: true,
          }),
        };
      }
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      return withRegisteredGraphMutation({
        server,
        operationKind: "provider.mutation",
        requestId: ctx.id,
        run: async ({ signal }) => {
          try {
            if (factory.hasBusySessions()) {
              return {
                error: createHostError("AGENT_BUSY", "Stop running sessions before changing Provider configuration", {
                  retryable: true,
                }),
              };
            }
            const config = await readModelsConfig(modelsPath);
            const enabledBefore = resolveEnabledProviders(
              config,
              factory.getGraph()?.agentSession?.model?.provider,
            );
            const wasFirstProvider = Object.keys(config.providers).length === 0;
            if (draft.id !== originalId && config.providers[draft.id] !== undefined) {
              return { error: createHostError("INVALID_REQUEST", `Provider already exists: ${draft.id}`) };
            }
            const existing = isObject(config.providers[originalId]) ? config.providers[originalId] : {};
            const modelConflict = currentModelConflict(
              factory,
              originalId,
              draft,
              Array.isArray(existing.models),
            );
            if (modelConflict) return { error: modelConflict };
            await invalidateRetainedRuntimes(factory);
            signal.throwIfAborted();
            const merged = mergeProvider(existing, draft);
            if (params.apiKey !== undefined || params.clearApiKey === true) delete merged.apiKey;
            if (draft.id !== originalId) delete config.providers[originalId];
            config.providers[draft.id] = merged;
            const enabledAfter = enabledBefore.map((id) => id === originalId ? draft.id : id);
            if (wasFirstProvider && !enabledAfter.includes(draft.id)) enabledAfter.push(draft.id);
            config.root[ENABLED_PROVIDERS_KEY] = [...new Set(enabledAfter)];
            delete config.root[LEGACY_ACTIVE_PROVIDER_KEY];

            const credentialStore = factory.deps.credentialStore;
            // Raw, not resolved: a renamed provider must carry its stored form.
            const oldSourceCredential = await credentialStore.readRaw(originalId);
            // One snapshot of the whole file rolls every credential change back
            // together, instead of replaying individual writes in reverse.
            const credentialSnapshot = await credentialStore.snapshot();
            await commitModelsConfig(modelsPath, config.root, factory);
            try {
              const newApiKey = params.apiKey;
              if (params.clearApiKey) {
                await credentialStore.delete(draft.id);
              } else if (newApiKey !== undefined) {
                await credentialStore.modify(draft.id, async () => ({
                  type: "api_key",
                  key: newApiKey,
                }));
              } else if (draft.id !== originalId && oldSourceCredential) {
                await credentialStore.modify(draft.id, async () => oldSourceCredential);
              }
              if (draft.id !== originalId) await credentialStore.delete(originalId);
              await refreshRegistry(factory, true);
              const currentProvider = factory.getGraph()?.agentSession?.model?.provider;
              const targetProvider = currentProvider && enabledAfter.includes(currentProvider)
                ? undefined
                : enabledAfter[0];
              await alignCurrentSessionModel(factory, targetProvider, targetProvider === draft.id
                ? draft.models.map((model) => model.id)
                : []);
            } catch (error) {
              await restoreModelsConfig(modelsPath, config.original);
              await credentialStore.restore(credentialSnapshot);
              await refreshRegistry(factory, true);
              throw error;
            }
            const enabledProviders = new Set(resolveEnabledProviders(config));
            return {
              result: {
                provider: providerSnapshot(draft.id, merged, factory, enabledProviders.has(draft.id)),
              },
            };
          } catch (error) {
            return {
              error: createHostError(
                "SETTINGS_WRITE_FAILED",
                error instanceof Error ? error.message : "Could not save Provider configuration",
              ),
            };
          }
        },
      });
    },

    "provider.remove": async (ctx) => {
      const { providerId } = ctx.params as { providerId: string };
      const conflict = currentModelConflict(factory, providerId);
      if (conflict) return { error: conflict };
      if (factory.hasBusySessions()) {
        return { error: createHostError("AGENT_BUSY", "Stop running sessions before deleting a Provider", { retryable: true }) };
      }
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      return withRegisteredGraphMutation({
        server,
        operationKind: "provider.mutation",
        requestId: ctx.id,
        run: async ({ signal }) => {
          try {
            const conflictUnderLock = currentModelConflict(factory, providerId);
            if (conflictUnderLock) return { error: conflictUnderLock };
            if (factory.hasBusySessions()) {
              return { error: createHostError("AGENT_BUSY", "Stop running sessions before deleting a Provider", { retryable: true }) };
            }
            const config = await readModelsConfig(modelsPath);
            if (config.providers[providerId] === undefined) {
              return { error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`) };
            }
            await invalidateRetainedRuntimes(factory);
            signal.throwIfAborted();
            const enabledBefore = resolveEnabledProviders(
              config,
              factory.getGraph()?.agentSession?.model?.provider,
            );
            delete config.providers[providerId];
            config.root[ENABLED_PROVIDERS_KEY] = enabledBefore.filter((id) => id !== providerId);
            delete config.root[LEGACY_ACTIVE_PROVIDER_KEY];
            const credentialSnapshot = await factory.deps.credentialStore.snapshot();
            await commitModelsConfig(modelsPath, config.root, factory);
            try {
              await factory.deps.credentialStore.delete(providerId);
              await refreshRegistry(factory, true);
            } catch (error) {
              await restoreModelsConfig(modelsPath, config.original);
              await factory.deps.credentialStore.restore(credentialSnapshot);
              await refreshRegistry(factory, true);
              throw error;
            }
            return { result: { providerId, removed: true as const } };
          } catch (error) {
            return {
              error: createHostError(
                "SETTINGS_WRITE_FAILED",
                error instanceof Error ? error.message : "Could not delete Provider",
              ),
            };
          }
        },
      });
    },

    "provider.fetchModels": async (ctx) => {
      const { providerId } = ctx.params as { providerId: string };
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      const shutdownSignal = server.getShutdownSignal();
      try {
        shutdownSignal.throwIfAborted();
        const captured = await withStableGraphRead({
          requestId: ctx.id,
          identity: server.identity,
          serviceGraphLock: server.serviceGraphLock,
          run: async (): Promise<ProviderFetchCapture> => {
            const config = await readModelsConfig(modelsPath);
            const raw = config.providers[providerId];
            if (!isObject(raw)) {
              return { error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`) };
            }
            const provider = providerSnapshot(
              providerId,
              raw,
              factory,
              resolveEnabledProviders(
                config,
                factory.getGraph()?.agentSession?.model?.provider,
              ).includes(providerId),
            );
            if (!provider.baseUrl) {
              return { error: createHostError("INVALID_REQUEST", "Provider Base URL is required") };
            }
            const apiKey = await factory.deps.modelRegistry.getApiKeyForProvider(providerId);
            return { snapshot: { original: config.original, provider, apiKey } };
          },
        });
        if (!captured.ok) return { error: captured.error, identity: captured.identity };
        if (!("snapshot" in captured.result)) {
          return { error: captured.result.error, identity: captured.identity };
        }

        const { original, provider, apiKey } = captured.result.snapshot;
        const models = await discoverModels(provider, apiKey, shutdownSignal);
        const validated = await readModelsOriginalUnderLock(server, modelsPath, ctx.id);
        if (!validated.ok) return { error: validated.error, identity: validated.identity };
        const stale = providerReadStaleError({
          capturedIdentity: captured.identity,
          validatedIdentity: validated.identity,
          capturedOriginal: original,
          validatedOriginal: validated.result,
          message: "Provider configuration changed while fetching models",
        });
        if (stale) {
          return {
            error: stale,
            identity: validated.identity,
          };
        }
        return { result: { providerId, models }, identity: validated.identity };
      } catch (error) {
        if (shutdownSignal.aborted) return { error: hostShuttingDownError() };
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "Could not fetch Provider models",
            { retryable: true },
          ),
        };
      }
    },

    "provider.checkConnection": async (ctx) => {
      const { providerId, modelId } = ctx.params as { providerId: string; modelId?: string };
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      const shutdownSignal = server.getShutdownSignal();
      try {
        shutdownSignal.throwIfAborted();
        const captured = await withStableGraphRead({
          requestId: ctx.id,
          identity: server.identity,
          serviceGraphLock: server.serviceGraphLock,
          run: async (): Promise<ProviderConnectionCapture> => {
            await refreshRegistry(factory);
            const config = await readModelsConfig(modelsPath);
            const raw = config.providers[providerId];
            if (!isObject(raw)) {
              return { error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`) };
            }
            const provider = providerSnapshot(
              providerId,
              raw,
              factory,
              resolveEnabledProviders(
                config,
                factory.getGraph()?.agentSession?.model?.provider,
              ).includes(providerId),
            );
            const targetModelId = modelId?.trim() || provider.models[0]?.id;
            if (!targetModelId) {
              return {
                error: createHostError(
                  "INVALID_REQUEST",
                  "Add and enable at least one model before testing the Provider",
                ),
              };
            }
            const model = factory.deps.modelRegistry.find(providerId, targetModelId);
            if (!model) {
              return {
                error: createHostError(
                  "MODEL_NOT_FOUND",
                  `Model not found in Provider ${providerId}: ${targetModelId}`,
                ),
              };
            }
            const auth = await factory.deps.modelRegistry.getApiKeyAndHeaders(model);
            return { snapshot: { original: config.original, provider, model, auth } };
          },
        });
        if (!captured.ok) return { error: captured.error, identity: captured.identity };
        if (!("snapshot" in captured.result)) {
          return { error: captured.result.error, identity: captured.identity };
        }

        const { original, provider, model, auth } = captured.result.snapshot;
        const result = await checkProviderConnection(
          provider,
          model,
          auth,
          shutdownSignal,
        );
        if (
          result.category !== "authentication" ||
          hasHeader(provider.headers, "authorization")
        ) {
          const validated = await readModelsOriginalUnderLock(server, modelsPath, ctx.id);
          if (!validated.ok) return { error: validated.error, identity: validated.identity };
          const stale = providerReadStaleError({
            capturedIdentity: captured.identity,
            validatedIdentity: validated.identity,
            capturedOriginal: original,
            validatedOriginal: validated.result,
            message: "Provider configuration changed during connection testing",
          });
          if (stale) {
            return {
              error: stale,
              identity: validated.identity,
            };
          }
          return { result, identity: validated.identity };
        }
        const detectedAuthHeader = !provider.authHeader;
        const retry = await checkProviderConnection(
          provider,
          model,
          auth,
          shutdownSignal,
          detectedAuthHeader,
        );
        if (!retry.ok) {
          const validated = await readModelsOriginalUnderLock(server, modelsPath, ctx.id);
          if (!validated.ok) return { error: validated.error, identity: validated.identity };
          const stale = providerReadStaleError({
            capturedIdentity: captured.identity,
            validatedIdentity: validated.identity,
            capturedOriginal: original,
            validatedOriginal: validated.result,
            message: "Provider configuration changed during connection testing",
          });
          if (stale) {
            return {
              error: stale,
              identity: validated.identity,
            };
          }
          return { result, identity: validated.identity };
        }
        shutdownSignal.throwIfAborted();
        const persistence = await persistDetectedAuthHeader(
          modelsPath,
          providerId,
          detectedAuthHeader,
          original,
          captured.identity,
          ctx.id,
          factory,
        );
        if ("error" in persistence) return persistence;
        return {
          result: {
            ...retry,
            message: `${retry.message} Authentication mode was detected automatically.`,
          },
          identity: persistence.identity,
        };
      } catch (error) {
        if (shutdownSignal.aborted) return { error: hostShuttingDownError() };
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "Could not test Provider connection",
            { retryable: true },
          ),
        };
      }
    },
  };
}
