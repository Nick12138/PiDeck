/**
 * Host-shaped model services for tests.
 *
 * Mirrors what main.ts builds — one credential store, one ModelRuntime with
 * the network disabled, and a ModelRegistry facade over it — so tests exercise
 * the same ownership arrangement as production instead of constructing
 * throwaway registries.
 */
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Credential } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "../credential-store.js";

export type TestModelServices = {
  credentialStore: FileCredentialStore;
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
};

export async function createTestModelServices(agentDir: string): Promise<TestModelServices> {
  const credentialStore = FileCredentialStore.forAgentDir(agentDir);
  const modelRuntime = await ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  return { credentialStore, modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}

/** Store an api-key credential the way a provider save does. */
export async function putApiKey(
  store: FileCredentialStore,
  providerId: string,
  key: string,
): Promise<void> {
  await store.modify(providerId, async () => ({ type: "api_key", key }));
}

/** Store any credential verbatim. */
export async function putCredential(
  store: FileCredentialStore,
  providerId: string,
  credential: Credential,
): Promise<void> {
  await store.modify(providerId, async () => credential);
}
