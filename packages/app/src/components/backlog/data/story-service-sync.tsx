import * as React from "react"

import { modelInputLimit } from "@/components/model/context-limits"
import { useModelSelection } from "@/components/model/model-selection"
import { useBlameRuntime } from "@/context/blame-runtime"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { personalizationStore } from "@/lib/personalization-store"
import { useStoryRunMode } from "@/lib/runtime-preference"
import { syncStoryService, type StorySync } from "@/lib/story-service"

/**
 * Tells the story service in the engine host what only this window knows:
 * the projects open on this computer, the account's agent model as the
 * picker resolves it, the person's settings and the Blame Runtime's phase.
 * The host starts every queued story of those projects with them.
 */
export function StoryServiceSync() {
  const auth = useCloudAuth()
  const engine = usePlatform().engine
  const projects = useProjects()
  const selection = useModelSelection({ role: "agent" })
  const premium = auth.license?.licensed === true
  const runMode = useStoryRunMode(premium)
  const runtimePhase = useBlameRuntime().phase
  const personalization = React.useSyncExternalStore(
    personalizationStore.subscribe,
    personalizationStore.get
  )
  const model = selection.currentModel
  const sync: StorySync = {
    projects: [
      ...(projects.activeProject ? [projects.activeProject] : []),
      ...projects.recentProjects,
    ].map(({ id, path }) => ({ id, path })),
    preferences: {
      ...(model
        ? {
            agentModel: {
              providerId: model.provider.id,
              modelId: model.id,
              ...(model.credentialLabel
                ? { credentialLabel: model.credentialLabel }
                : {}),
              ...(selection.currentVariant
                ? { reasoning: selection.currentVariant }
                : {}),
              ...maxInputTokens(model, selection.allProviders),
            },
          }
        : {}),
      personalization,
      runMode,
      premium,
      runtimePhase,
    },
  }
  const serialized = JSON.stringify(sync)
  const signedIn = auth.status === "authenticated"
  React.useEffect(() => {
    if (!engine || !signedIn) return
    void syncStoryService(engine, JSON.parse(serialized) as StorySync).catch(
      (error: unknown) =>
        console.error("The story service could not be told.", error)
    )
  }, [engine, serialized, signedIn])
  return null
}

function maxInputTokens(
  model: Parameters<typeof modelInputLimit>[0],
  providers: Parameters<typeof modelInputLimit>[1]
) {
  const limit = modelInputLimit(model, providers)
  return limit ? { maxInputTokens: limit } : {}
}
