import { Layers2Icon } from "lucide-react"

import { EpicModelRangeField } from "./epic-model-range-field"
import { EpicProviderField } from "./epic-provider-field"
import type { useNewEpicModels } from "./use-new-epic-models"

export function NewEpicModelFields({
  choices,
  disabled,
}: {
  choices: ReturnType<typeof useNewEpicModels>
  disabled: boolean
}) {
  const { draft, models, change } = choices
  return (
    <fieldset
      aria-label="Story agents"
      disabled={disabled}
      inert={disabled}
      className="mx-4 grid min-w-0 gap-4 border-t border-foreground/10 pt-4 pb-4 @xl/epic:mx-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Layers2Icon
            aria-hidden="true"
            className="size-4 text-muted-foreground"
          />
          Story agents
        </h3>
        <EpicProviderField
          connected={models.connectedProviders}
          value={draft.providers}
          onChange={(providers) => change({ providers })}
        />
      </div>
      <div className="min-w-0">
        {models.loading && !models.recommendations ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading story models…
          </p>
        ) : (
          <EpicModelRangeField
            hidden={choices.settings.hiddenModels}
            modelName={models.modelName}
            providers={draft.providers}
            range={draft.range}
            recommendations={models.recommendations}
            onChange={(range) => change({ range })}
          />
        )}
      </div>
    </fieldset>
  )
}
