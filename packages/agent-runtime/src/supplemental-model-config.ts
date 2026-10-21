import {
  missingProviderModels,
  supplementalModels,
  type SupplementalModel,
} from "@blame/model-catalog";
import { getProviderCollectionSync, type ModelInfo } from "@cline/llms";
import type { CoreModelConfig } from "@cline/sdk";

import { claudeCodeModelConfig } from "./claude-code/claude-code-provider.js";

// Models resolved from the Blame API catalog, which tracks newer Cline releases
// and live provider catalogs than the SDK bundled in this runtime.
const catalogModels = new Map<string, Record<string, ModelInfo>>();

/** knownModels is serialized by Cline for local, remote and delegated sessions. */
export function supplementalModelConfig<T extends CoreModelConfig>(
  requested: T,
  entries: readonly SupplementalModel[] = supplementalModels,
): T {
  const config = claudeCodeModelConfig(requested);
  const providerId = config.providerConfig?.providerId ?? config.providerId;
  const official = getProviderCollectionSync(providerId)?.models;
  // Never invent a new provider or overwrite a Cline registry entry.
  if (!official) return config;
  const missing = {
    ...missingProviderModels(providerId, official, entries),
    ...withoutOfficial(catalogModels.get(providerId), official),
  };
  const modelId = config.providerConfig?.modelId ?? config.modelId;
  if (!Object.hasOwn(missing, modelId)) return config;
  return {
    ...config,
    knownModels: { ...missing, ...config.knownModels },
    ...(config.providerConfig
      ? {
          providerConfig: {
            ...config.providerConfig,
            knownModels: { ...missing, ...config.providerConfig.knownModels },
          },
        }
      : {}),
  };
}

/**
 * Fetches catalog metadata for a model the bundled Cline registry lacks, so a
 * model released after this runtime starts with its real limits. Failures keep
 * the bundled behaviour.
 */
export async function loadCatalogModel(
  fetchModel: () => Promise<ModelInfo | undefined>,
  providerId: string,
  modelId: string,
) {
  const official = getProviderCollectionSync(providerId)?.models;
  if (!official || Object.hasOwn(official, modelId)) return;
  if (catalogModels.get(providerId)?.[modelId]) return;
  const model = await fetchModel().catch(() => undefined);
  if (!model || typeof model !== "object") return;
  catalogModels.set(providerId, {
    ...catalogModels.get(providerId),
    [modelId]: model,
  });
}

function withoutOfficial(
  models: Record<string, ModelInfo> | undefined,
  official: Record<string, unknown>,
) {
  return Object.fromEntries(
    Object.entries(models ?? {}).filter(([id]) => !Object.hasOwn(official, id)),
  );
}
