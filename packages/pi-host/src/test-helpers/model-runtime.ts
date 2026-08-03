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
import { FileCredentialStore } from "../credential-store.js";
import { ExtensionProviderOwnership } from "../extension-provider-ownership.js";

export type TestModelServices = {
  credentialStore: FileCredentialStore;
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
  providerOwnership: ExtensionProviderOwnership;
};

export async function createTestModelServices(agentDir: string): Promise<TestModelServices> {
  const credentialStore = FileCredentialStore.forAgentDir(agentDir);
  const modelRuntime = await ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  return {
    credentialStore,
    modelRuntime,
    modelRegistry: new ModelRegistry(modelRuntime),
    providerOwnership: new ExtensionProviderOwnership(modelRuntime),
  };
}

/** Store an api-key credential the way a provider save does. */
export async function putApiKey(
  store: FileCredentialStore,
  providerId: string,
  key: string,
): Promise<void> {
  await store.modify(providerId, async () => ({ type: "api_key", key }));
}
