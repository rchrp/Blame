import type { EngineModelChoice } from "@blame/agent-runtime/engine-protocol"

import type { useModelSelection } from "@/components/model/model-selection"

type Selection = ReturnType<typeof useModelSelection>

/** The model picked in a selector, as the engine host takes it. */
export function engineModelChoice(selection: Selection): EngineModelChoice {
  const model = selection.currentModel!
  return {
    providerId: model.provider.id,
    modelId: model.id,
    credentialLabel: model.credentialLabel,
    reasoning: selection.currentVariant,
  }
}
