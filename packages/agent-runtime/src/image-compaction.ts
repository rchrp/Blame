import type { CoreCompactionConfig } from "@cline/sdk";

// The app's provider ids (the engine's).
const boundedProviders = new Set(["openai", "chatgpt"]);
const boundedModels = /^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/u;

export function imageAwareCompaction(
  config: CoreCompactionConfig,
  providerId: string,
  modelId: string,
): CoreCompactionConfig {
  if (config.enabled === false || config.imageTokenLimit !== undefined) return config;
  if (!boundedProviders.has(providerId) || !boundedModels.test(modelId)) return config;
  return { ...config, imageTokenLimit: 36_000 };
}
