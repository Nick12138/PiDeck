import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { detectModelThinking } from "@pideck/protocol";

type RegisteredProviderConfig = NonNullable<
  ReturnType<ModelRegistry["getRegisteredProviderConfig"]>
>;
type RegisteredModel = NonNullable<RegisteredProviderConfig["models"]>[number];

/**
 * Apply exact built-in capability profiles without overriding explicit user
 * configuration.
 *
 * This goes through each provider's registered configuration rather than
 * mutating the models returned by `getAll()`. Under SDK 0.82.1 a composed
 * provider rebuilds its model objects on every access, so a mutation applied to
 * a `getAll()` result is discarded — and `find()` would hand the session a
 * different instance without the map. Re-registering routes the profile through
 * the composer's override path, where it survives recomposition and reaches the
 * request layer that actually reads `thinkingLevelMap`.
 */
export function applyKnownThinkingProfiles(modelRegistry: ModelRegistry): number {
  let applied = 0;
  for (const providerId of modelRegistry.getRegisteredProviderIds()) {
    const config = modelRegistry.getRegisteredProviderConfig(providerId);
    const models = config?.models;
    if (!config || !Array.isArray(models)) continue;

    let changed = false;
    const nextModels: RegisteredModel[] = models.map((model) => {
      if (!model.reasoning || model.thinkingLevelMap !== undefined) return model;
      const detected = detectModelThinking(model.id);
      if (detected.source !== "profile" || !detected.thinkingLevelMap) return model;
      changed = true;
      applied += 1;
      return { ...model, thinkingLevelMap: { ...detected.thinkingLevelMap } };
    });

    // Re-register only on change: registration recomposes the provider.
    if (changed) modelRegistry.registerProvider(providerId, { ...config, models: nextModels });
  }
  return applied;
}

/** Rebind a live session after ModelRegistry.refresh() without appending a model-change entry. */
export function rebindCurrentSessionModel(
  session: AgentSession,
  modelRegistry: ModelRegistry,
): boolean {
  const current = session.model;
  if (!current) return false;
  const refreshed = modelRegistry.find(current.provider, current.id);
  if (!refreshed || refreshed === current) return false;
  session.state.model = refreshed;
  session.setThinkingLevel(session.thinkingLevel);
  return true;
}
