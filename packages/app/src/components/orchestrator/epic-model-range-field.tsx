import type { ModelRecommendations } from "@blame/agent-runtime"

import {
  intentModels,
  modelIntentLabels,
  modelIntents,
  rankedEpicModels,
} from "@/components/orchestrator/data/epic-model-range"
import type { EpicModelKey } from "@/components/orchestrator/data/epic-data"
import { ProviderIcon } from "@/components/model/model-selector"
import {
  NotchedRangeSlider,
  type NotchedRange,
} from "@/components/ui/notched-range-slider"

// The models stories may use: the smart slider's notches with two handles,
// and what each intent picks inside the range, so the person sees the
// models, not only a position.
export function EpicModelRangeField({
  hidden,
  modelName,
  providers,
  range,
  recommendations,
  onChange,
}: {
  hidden: EpicModelKey[]
  modelName: (key: EpicModelKey) => string
  providers: string[]
  range: NotchedRange
  recommendations: ModelRecommendations | undefined
  onChange: (range: NotchedRange) => void
}) {
  const pool = { hidden, providers, recommendations }
  const ranked = rankedEpicModels(pool)
  const picks = intentModels(pool, range)
  if (!ranked.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No ranked models available. Stories can use your default agent model if
        these providers allow it.
      </p>
    )
  }
  const markers = ranked.map((item) => item.rank)
  const nameAt = (position: number) => {
    const item = ranked.reduce((best, candidate) =>
      Math.abs(candidate.rank - position) < Math.abs(best.rank - position)
        ? candidate
        : best
    )
    return modelName(item)
  }
  return (
    <div className="@container/model-range grid min-w-0 gap-1">
      <div className="flex justify-between px-1 text-xs text-muted-foreground">
        <span>Cheaper</span>
        <span>Smarter</span>
      </div>
      <NotchedRangeSlider
        ariaLabel="Models stories may use"
        markers={markers}
        range={range}
        valueText={(_, position) => nameAt(position)}
        onChange={onChange}
      />
      {picks ? (
        <dl className="mt-1 grid gap-x-4 gap-y-2 border-t border-foreground/8 pt-3 text-sm @sm/model-range:grid-cols-3">
          {modelIntents.map((intent) => (
            <div
              key={intent}
              className="flex min-w-0 items-center justify-between gap-2 @sm/model-range:grid @sm/model-range:justify-start @sm/model-range:gap-0.5"
            >
              <dt className="text-xs text-muted-foreground">
                {modelIntentLabels[intent]}
              </dt>
              <dd className="flex min-w-0 items-center gap-1.5 font-medium">
                <ProviderIcon
                  className="shrink-0"
                  providerId={picks[intent].providerId}
                />
                <span className="min-w-0 break-words">
                  {modelName(picks[intent])}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}
