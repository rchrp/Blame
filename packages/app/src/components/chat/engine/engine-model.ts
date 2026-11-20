import type { EngineModelChoice } from "@blame/agent-runtime/engine-protocol"
import { engineProviderId } from "@blame/agent-runtime/engine-protocol"

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

/** Why the picked model cannot run on the engine, when it cannot. */
export function engineModelUnavailable(selection: Selection) {
  const model = selection.currentModel
  if (model && !engineProviderId(model.provider.id))
    return `${model.provider.name} models do not run on Blame's agent engine yet: pick another model.`
  return undefined
}
