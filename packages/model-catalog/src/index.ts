import type { ProviderModels, SupplementalModel } from "./types.js";

export type { ProviderModels, SupplementalModel } from "./types.js";

/**
 * Add one module here for each temporary model addition. Remove it once the
 * bundled Cline release ships the model (GPT-6 Astra: Cline 0.0.95).
 */
export const supplementalModels: readonly SupplementalModel[] = [];

export function supplementalModelStatus(
  entry: SupplementalModel,
  officialModels: ProviderModels,
): "disabled" | "official" | "active" {
  if (entry.enabled === false) return "disabled";
  return Object.hasOwn(officialModels, entry.model.id) ? "official" : "active";
}

export function missingProviderModels(
  providerId: string,
  officialModels: ProviderModels,
  entries: readonly SupplementalModel[] = supplementalModels,
): ProviderModels {
  const missing: ProviderModels = {};
  for (const entry of entries) {
    if (entry.providerId !== providerId) continue;
    if (supplementalModelStatus(entry, officialModels) !== "active") continue;
    if (Object.hasOwn(missing, entry.model.id)) {
      throw new Error(
        `Duplicate supplemental model: ${providerId}/${entry.model.id}`,
      );
    }
    missing[entry.model.id] = structuredClone(entry.model);
  }
  return missing;
}

/** Official metadata wins wholesale, including deprecation and removed fields. */
export function withSupplementalModels(
  providerId: string,
  officialModels: ProviderModels,
  entries: readonly SupplementalModel[] = supplementalModels,
): ProviderModels {
  return {
    ...missingProviderModels(providerId, officialModels, entries),
    ...officialModels,
  };
}
