import { getAllProviders, getModelsForProvider } from "@cline/llms";
import { withSupplementalModels } from "@blame/model-catalog";
import type { ModelInfo, ProviderInfo } from "@cline/llms";

import type { BlameModel, BlameProvider } from "./types.js";

// Claude Code runs through Blame's local bridge; the Codex CLI provider is
// not wired yet and the OpenAI Codex OAuth provider covers the subscription.
const externalCliProviderIds = new Set(["openai-codex-cli"]);

export async function listClineProviders() {
  const providers: ProviderInfo[] = await getAllProviders();
  const withModels: BlameProvider[] = await Promise.all(
    providers
      .filter((provider) => isBaseRuntimeProvider(provider.id))
      .map((provider) => toBlameProvider(provider)),
  );
  return withModels.filter(
    (provider: BlameProvider) => Object.keys(provider.models).length > 0,
  );
}

export function isBaseRuntimeProvider(providerId: string) {
  return !externalCliProviderIds.has(providerId);
}

async function toBlameProvider(provider: ProviderInfo): Promise<BlameProvider> {
  const models = await clineModels(provider.id);

  return {
    id: provider.id,
    name: provider.name,
    description: provider.description,
    baseUrl: provider.baseUrl,
    defaultModelId: provider.defaultModelId,
    capabilities: provider.capabilities,
    models: Object.fromEntries(
      Object.entries(models).map(([modelId, model]) => [
        modelId,
        toBlameModel(modelId, model),
      ]),
    ),
  };
}

function toBlameModel(modelId: string, model: ModelInfo): BlameModel {
  return {
    id: model.id ?? modelId,
    name: model.name ?? modelId,
    status: model.status,
    description: model.description,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    capabilities: model.capabilities,
    releaseDate: model.releaseDate,
    cost: {
      input: model.pricing?.input ?? null,
      output: model.pricing?.output ?? null,
      cacheRead: model.pricing?.cacheRead ?? null,
      cacheWrite: model.pricing?.cacheWrite ?? null,
    },
    variants: reasoningVariants(model),
  };
}

export async function clineModels(providerId: string) {
  return withSupplementalModels(providerId, await getModelsForProvider(providerId));
}

function reasoningVariants(model: ModelInfo) {
  const effortOption = reasoningOptions(model).find(
    (option) => option.type === "effort",
  );
  if (effortOption?.values) {
    const variants = Object.fromEntries(
      effortOption.values.flatMap((value) =>
        isSelectableReasoningEffort(value)
          ? [
              [
                value,
                value === "none"
                  ? { thinking: false }
                  : { reasoningEffort: value, thinking: true },
              ],
            ]
          : [],
      ),
    );
    if (Object.keys(variants).length) return variants;
  }
  if (
    reasoningOptions(model).some(
      (option) => option.type === "toggle" || option.type === "budget_tokens",
    )
  ) {
    return { enabled: { thinking: true } };
  }
  if (!model.capabilities?.includes("reasoning")) return undefined;
  return fallbackReasoningVariants;
}

function reasoningOptions(model: ModelInfo) {
  return (model.reasoningOptions ?? []) as Array<{
    type: string;
    values?: unknown[];
  }>;
}

const fallbackReasoningVariants = {
  low: { reasoningEffort: "low", thinking: true },
  medium: { reasoningEffort: "medium", thinking: true },
  high: { reasoningEffort: "high", thinking: true },
  xhigh: { reasoningEffort: "xhigh", thinking: true },
};

function isSelectableReasoningEffort(value: unknown): value is string {
  return (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}
