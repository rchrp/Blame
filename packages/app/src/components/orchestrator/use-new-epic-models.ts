import * as React from "react"
import { z } from "zod"

import { composerDraftStorageKey } from "@/components/backlog/drawer/composer-draft-storage"
import { engineModelChoice } from "@/components/chat/engine/engine-model"
import { type EpicSettings, wholeModelRange } from "./data/epic-data"
import { useEpicModels } from "./data/use-epic-models"

const bound = z.number().min(0).max(1)
const draftSchema = z.object({
  orchestrator: z
    .object({
      providerId: z.string(),
      modelId: z.string(),
      credentialLabel: z.string().nullable(),
      reasoningEffort: z
        .enum([
          "none",
          "enabled",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ])
        .nullable(),
    })
    .nullable(),
  providers: z.array(z.string()),
  range: z
    .object({ min: bound, max: bound })
    .refine(({ min, max }) => min <= max),
})
type ModelDraft = z.infer<typeof draftSchema>

function readDraft(key: string): ModelDraft {
  try {
    const saved = localStorage.getItem(key)
    if (saved) {
      const result = draftSchema.safeParse(JSON.parse(saved))
      if (result.success) return result.data
    }
  } catch {
    // A missing or obsolete draft opens with the account's current model.
  }
  return { orchestrator: null, providers: [], range: wholeModelRange }
}

function storeDraft(key: string, draft: ModelDraft | null) {
  try {
    if (draft) localStorage.setItem(key, JSON.stringify(draft))
    else localStorage.removeItem(key)
  } catch {
    // A full or unavailable local store must not interrupt creation.
  }
}

export function useNewEpicModels(projectId: string) {
  const key = composerDraftStorageKey(projectId, "epic") + ":models"
  const [draft, setDraft] = React.useState(() => readDraft(key))
  function change(patch: Partial<ModelDraft>) {
    const next = { ...draft, ...patch }
    setDraft(next)
    storeDraft(key, next)
  }
  const scope = {
    preference: draft.orchestrator,
    onChange: (orchestrator: NonNullable<ModelDraft["orchestrator"]>) =>
      change({ orchestrator }),
  }
  const models = useEpicModels(scope)
  const settings = {
    askBeforeLaunch: false,
    hiddenModels: models.hiddenModels(),
    modelRange: draft.range,
    providers: draft.providers,
    ...(models.currentModel
      ? { orchestratorModel: engineModelChoice(models) }
      : {}),
  } satisfies EpicSettings
  return {
    models,
    scope,
    draft,
    settings,
    change,
    clear: () => storeDraft(key, null),
  }
}
