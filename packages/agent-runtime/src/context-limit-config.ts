// Cline applies providerConfig.maxInputTokens to the session's model as both
// its context window and input limit, so compaction follows the cap.
export function contextLimitConfig(input: {
  maxInputTokens?: number;
  modelId: string;
  providerId: string;
}) {
  const limit = input.maxInputTokens;
  if (limit === undefined || !Number.isFinite(limit) || limit < 1_000)
    return {};
  return {
    providerConfig: {
      providerId: input.providerId,
      modelId: input.modelId,
      maxInputTokens: Math.floor(limit),
    },
  };
}
