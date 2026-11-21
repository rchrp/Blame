import {
  escalateModel,
  resolveModelIntent,
  type ModelIntent,
  type ModelKey,
  type ModelPool,
} from "@blame/agent-runtime/engine-protocol"

// The models an epic's stories may run on, as the engine host ranks them
// when it turns an intent into a model (`resolveModelIntent`): the settings'
// range slider puts its notches on these positions, so a handle set on a
// notch is the slice the host reads, and the preview names the model each
// intent would pick. The ranking is the host's own: walked from the
// cheapest model up, one `escalateModel` at a time.

export type { ModelIntent } from "@blame/agent-runtime/engine-protocol"

export type EpicModelPool = Omit<ModelPool, "range" | "recommendations"> & {
  recommendations: ModelPool["recommendations"] | undefined
}

export type RankedModel = ModelKey & { rank: number }

export const modelIntents: readonly ModelIntent[] = [
  "cheaper",
  "balanced",
  "smarter",
]

export const modelIntentLabels: Record<ModelIntent, string> = {
  cheaper: "Cheaper",
  balanced: "Balanced",
  smarter: "Smarter",
}

const wholeScale = { min: 0, max: 1 }
// Without a ranked model the host falls back to the account's: no notch.
const noFallback = { providerId: "", modelId: "" }

export function rankedEpicModels(input: EpicModelPool): RankedModel[] {
  if (!input.recommendations) return []
  const pool = {
    ...input,
    recommendations: input.recommendations,
    range: wholeScale,
  }
  const first = resolveModelIntent({
    ...pool,
    intent: "cheaper",
    fallback: noFallback,
  })
  if (first.fallback || first.position === null) return []
  const ranked: RankedModel[] = [{ ...key(first.model), rank: first.position }]
  for (let current = first.model; ranked.length < 500;) {
    const next = escalateModel({ ...pool, current })
    if (!next || next.position === null) break
    ranked.push({ ...key(next.model), rank: next.position })
    current = next.model
  }
  return ranked
}

/** What each intent would pick inside the range now, as the host picks it. */
export function intentModels(
  input: EpicModelPool,
  range: { min: number; max: number }
): Record<ModelIntent, ModelKey> | undefined {
  if (!input.recommendations) return undefined
  const pool = { ...input, recommendations: input.recommendations, range }
  const picks = modelIntents.map((intent) =>
    resolveModelIntent({ ...pool, intent, fallback: noFallback })
  )
  if (picks.some((pick) => pick.fallback)) return undefined
  return {
    cheaper: key(picks[0]!.model),
    balanced: key(picks[1]!.model),
    smarter: key(picks[2]!.model),
  }
}

function key(model: ModelKey): ModelKey {
  return { providerId: model.providerId, modelId: model.modelId }
}
