import { getProviderCollectionSync } from "@cline/llms";
import type { CoreModelConfig } from "@cline/sdk";

import { claudeCodeModelConfig } from "./claude-code/claude-code-provider.js";

// The Cline story path until it moves to the engine. The app names providers
// by the engine's ids; Cline names two of them its own way. This mapping
// dies with the Cline path.
const clineIds: Record<string, string> = {
  openai: "openai-native",
  chatgpt: "openai-codex",
};

/** Cline's id for the engine's provider id. */
export function clineProviderId(providerId: string) {
  return clineIds[providerId] ?? providerId;
}

/** A Cline config with Cline's provider ids and the Claude Code bridge's model. */
export function supplementalModelConfig<T extends CoreModelConfig>(
  requested: T,
): T {
  const config = claudeCodeModelConfig({
    ...requested,
    providerId: clineProviderId(requested.providerId),
    ...(requested.providerConfig
      ? {
          providerConfig: {
            ...requested.providerConfig,
            providerId: clineProviderId(requested.providerConfig.providerId),
          },
        }
      : {}),
  });
  return config;
}

/**
 * Metadata of a model from the registry bundled with Cline. A model it does
 * not know runs with Cline's defaults: the engine, not Cline, reads
 * models.dev.
 */
export function knownModelInfo(providerId: string, modelId: string) {
  return getProviderCollectionSync(clineProviderId(providerId))?.models[
    modelId
  ];
}
