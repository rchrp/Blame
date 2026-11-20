// The engine's catalog (models.dev, `catalog/list`) as the model pickers
// show it: one provider per engine provider, with the person's credentials
// and the API's recommendations. Pure: the host fetches, this shapes.

import type {
  ModelCatalog,
  ModelInfo,
  ProviderInfo,
  ReasoningEffort,
} from "@blame/engine-client";
import type {
  BlameModel,
  BlameProvider,
  ModelRecommendations,
  ProviderCredentialSummary,
  ProviderListResponse,
  ReasoningSelection,
} from "../types.js";

export const openAICompatibleProviderId = "openai-compatible";

/** Models a server lists on its own `/models`, by credential label. */
export type CompatibleModels = Record<string, string[]>;

export function emptyRecommendations(): ModelRecommendations {
  return {
    generatedAt: new Date(0).toISOString(),
    benchmarkBoundary: 0,
    all: [],
    byProvider: {},
    profile: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      sampleCount: 0,
    },
  };
}

export function providerList(input: {
  catalog: ModelCatalog;
  credentials: ProviderCredentialSummary[];
  compatibleModels?: CompatibleModels;
  recommendations?: ModelRecommendations;
}): ProviderListResponse {
  const recommendations = input.recommendations ?? emptyRecommendations();
  // A server's own models join the ones saved with its credential: the
  // picker lists a credential's models.
  const credentials = input.credentials.map((credential) => {
    const listed = input.compatibleModels?.[credential.label];
    if (credential.providerId !== openAICompatibleProviderId || !listed)
      return credential;
    return {
      ...credential,
      modelIds: [...new Set([...(credential.modelIds ?? []), ...listed])],
    };
  });
  const all = input.catalog.providers.map((provider) =>
    blameProvider(provider, credentials, input.compatibleModels ?? {}),
  );
  const connected = [
    ...new Set(credentials.map((credential) => credential.providerId)),
  ];
  return {
    all,
    connected,
    default: Object.fromEntries(
      all.flatMap((provider) => {
        const recommended =
          recommendations.byProvider[provider.id]?.[0]?.modelId;
        const first = Object.keys(provider.models)[0];
        const chosen = recommended ?? first;
        return chosen ? [[provider.id, chosen]] : [];
      }),
    ),
    credentials,
    recommendations,
  };
}

function blameProvider(
  provider: ProviderInfo,
  credentials: ProviderCredentialSummary[],
  compatibleModels: CompatibleModels,
): BlameProvider {
  const models =
    provider.id === openAICompatibleProviderId
      ? compatibleProviderModels(credentials, compatibleModels)
      : provider.models.map(blameModel);
  return {
    id: provider.id,
    name: provider.name,
    // The ChatGPT plan signs in in the browser; the connect dialog reads
    // this to offer it.
    capabilities: provider.id === "chatgpt" ? ["oauth"] : [],
    models: Object.fromEntries(models.map((model) => [model.id, model])),
  };
}

/**
 * An OpenAI-compatible server's models: the ids saved with each credential,
 * and what the server's `/models` lists. Nothing is known about them but
 * their id.
 */
function compatibleProviderModels(
  credentials: ProviderCredentialSummary[],
  compatibleModels: CompatibleModels,
): BlameModel[] {
  const ids = new Set<string>();
  for (const credential of credentials) {
    if (credential.providerId !== openAICompatibleProviderId) continue;
    for (const id of credential.modelIds ?? []) ids.add(id);
    for (const id of compatibleModels[credential.label] ?? []) ids.add(id);
  }
  return [...ids].map((id) => ({
    id,
    name: id,
    capabilities: ["tools"],
    cost: { input: null, output: null },
    variants: {},
  }));
}

export function blameModel(model: ModelInfo): BlameModel {
  const perMillion = (micro: number | undefined) =>
    micro === undefined ? null : micro / 1_000_000;
  return {
    id: model.id,
    name: model.name,
    ...(model.status ? { status: model.status } : {}),
    ...(model.context_window ? { contextWindow: model.context_window } : {}),
    ...(model.max_input_tokens
      ? { maxInputTokens: model.max_input_tokens }
      : {}),
    ...(model.max_output_tokens ? { maxTokens: model.max_output_tokens } : {}),
    ...(model.release_date ? { releaseDate: model.release_date } : {}),
    capabilities: [
      "tools",
      ...(model.images ? ["images"] : []),
      ...(model.pdf ? ["files"] : []),
      ...(model.reasoning.supported ? ["reasoning"] : []),
    ],
    cost: {
      input: perMillion(model.price?.input),
      output: perMillion(model.price?.output),
      cacheRead: perMillion(model.price?.cache_read),
      cacheWrite: perMillion(model.price?.cache_write),
    },
    variants: Object.fromEntries(
      reasoningChoices(model).map((choice) => [choice, {}]),
    ),
  };
}

/**
 * The reasoning choices the picker offers for a model, in the app's words:
 * the levels the model takes, and `none` only when it can stop reasoning.
 * A model that reasons without saying how gets the common three, which the
 * engine sends as asked.
 */
export function reasoningChoices(model: ModelInfo): ReasoningSelection[] {
  const reasoning = model.reasoning;
  if (!reasoning.supported) return [];
  const levels: ReasoningEffort[] = reasoning.efforts.length
    ? reasoning.efforts
    : ["low", "medium", "high"];
  return [
    ...(reasoning.can_disable ? (["none"] as const) : []),
    ...levels.filter((level) => level !== "off"),
  ];
}
