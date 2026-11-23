import * as React from "react"
import type { ReasoningSelection } from "@blame/agent-runtime"

import type {
  EpicModelKey,
  EpicOrchestratorModel,
} from "@/components/orchestrator/data/epic-data"
import {
  useModelSelection,
  type ModelSelectionScope,
} from "@/components/model/model-selection"
import type { CloudAiModelPreference } from "@/context/cloud-auth"

// What the orchestrator's screen needs of the person's models: their names,
// the ones hidden in the model selector, the ranking and the providers.
export function useEpicModels(scope?: ModelSelectionScope) {
  const selection = useModelSelection({ role: "agent", scope })
  const allModels = React.useMemo(
    () => selection.allProviderGroups.flatMap((group) => group.models),
    [selection.allProviderGroups]
  )

  const modelName = React.useCallback(
    (key: EpicModelKey) =>
      allModels.find(
        (model) =>
          model.provider.id === key.providerId && model.id === key.modelId
      )?.name ?? key.modelId,
    [allModels]
  )

  // The models the person hid in the model selector (kept per project on
  // this computer); the settings copy them to the epic for the host.
  const hiddenModels = (): EpicModelKey[] => {
    const seen = new Set<string>()
    return allModels
      .filter((model) => !selection.modelVisible(model))
      .map((model) => ({ providerId: model.provider.id, modelId: model.id }))
      .filter((key) => {
        const id = `${key.providerId}\n${key.modelId}`
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
  }

  return {
    allProviders: selection.allProviders,
    connectedProviders: selection.connectedProviders,
    currentModel: selection.currentModel,
    currentVariant: selection.currentVariant,
    loading: selection.loading,
    hiddenModels,
    modelName,
    recommendations: selection.recommendations,
  }
}

export function orchestratorPreference(
  model: EpicOrchestratorModel | undefined
): CloudAiModelPreference | null {
  if (!model) return null
  return {
    credentialLabel: model.credentialLabel ?? null,
    modelId: model.modelId,
    providerId: model.providerId,
    reasoningEffort:
      (model.reasoning as ReasoningSelection | undefined) ?? null,
  }
}

export function orchestratorModel(
  preference: CloudAiModelPreference
): EpicOrchestratorModel {
  return {
    providerId: preference.providerId,
    modelId: preference.modelId,
    ...(preference.credentialLabel
      ? { credentialLabel: preference.credentialLabel }
      : {}),
    ...(preference.reasoningEffort
      ? { reasoning: preference.reasoningEffort }
      : {}),
  }
}
