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
      className="mx-4 grid min-w-0 gap-2.5 border-t border-border/65 pt-3 pb-4 @xl/epic:mx-5 @xl/epic:grid-cols-[9rem_minmax(0,1fr)] @xl/epic:items-baseline @xl/epic:gap-4"
    >
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Layers2Icon
          aria-hidden="true"
          className="size-4 text-muted-foreground"
        />
        Story agents
      </h3>
      <div className="grid min-w-0 gap-2.5 @xl/epic:w-full @xl/epic:max-w-md @xl/epic:justify-self-end">
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
        <div className="flex max-w-full flex-wrap items-center gap-x-2.5 gap-y-1.5 @xl/epic:justify-end @xl/epic:[&>[role=group]]:justify-end">
          <span className="text-xs text-muted-foreground">Providers</span>
          <EpicProviderField
            connected={models.connectedProviders}
            value={draft.providers}
            onChange={(providers) => change({ providers })}
          />
        </div>
      </div>
    </fieldset>
  )
}
