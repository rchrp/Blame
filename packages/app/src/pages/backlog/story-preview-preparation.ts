import type { ExecutionTelemetryCohorts } from "@blame/agent-runtime"
import * as React from "react"
import { toast } from "sonner"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import type { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { setStoryPreviewWaiting } from "@/components/backlog/data/preview-environment-waits"
import { useModelSelection } from "@/components/model/model-selection"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { storyTelemetryCohorts } from "./backlog-rotation-helpers"
import { syncPreviewEnvironment } from "./preview-environment-sync"

// A story's worktree gets its preview setup from the project's preview
// environment once that is checked against the latest commits. Until then
// its preview pane waits; its agent works meanwhile. Each worktree is
// prepared once per app session: when its story starts, or, if the app quit
// before it could, once the backlog loads again.

type Preparation = {
  auth: ReturnType<typeof useCloudAuth>
  backlog: ReturnType<typeof useBacklogStore>
  platform: ReturnType<typeof usePlatform>
  project?: { id: string; path: string }
  selection: ReturnType<typeof useModelSelection>
}

type Execution = { id: string; telemetryCohorts?: ExecutionTelemetryCohorts }

type PreviewStory = UserStory & {
  worktree: string
  workspaceMode: "local-container" | "cloud-mirror"
}

const preparedWorktrees = new Set<string>()
const startingStories = new Map<string, Execution>()
const previewManifestPath = ".blame/initialization/preview-manifest.json"

/** Prepares the preview of a story starting now within its start. */
export function prepareStartingStoryPreview(
  storyId: string,
  execution: Execution
) {
  startingStories.set(storyId, execution)
}

/** Prepares the preview of every active story whose worktree needs it. */
export function useStoryPreviewPreparation(
  backlog: ReturnType<typeof useBacklogStore>
) {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const project = useProjects().activeProject
  // The model of the setup agents, as for a merge.
  const selection = useModelSelection({ role: "alternative" })
  const ready = Boolean(
    project && selection.currentModel && platform.workspace && !backlog.loading
  )
  // What a preparation reads at each step: the latest of it.
  const current = React.useEffectEvent((): Preparation => ({
    auth,
    backlog,
    platform,
    project,
    selection,
  }))
  React.useEffect(() => {
    if (!ready) return
    for (const story of backlog.stories) {
      if (!previewStory(story)) continue
      const key = `${story.id}:${story.worktree}`
      if (preparedWorktrees.has(key)) continue
      preparedWorktrees.add(key)
      const started = startingStories.get(story.id)
      startingStories.delete(story.id)
      void prepareStoryPreview(current, story, started)
    }
  }, [backlog.stories, ready])
}

async function prepareStoryPreview(
  current: () => Preparation,
  story: PreviewStory,
  started: Execution | undefined
) {
  const workspace = current().platform.workspace
  if (!workspace) return
  // A worktree from an earlier session usually has its setup already.
  if (!started && (await previewSetupWritten(workspace, story.worktree))) return
  setStoryPreviewWaiting(story.id, true)
  try {
    const environment = await checkedEnvironment(current())
    // Still active on this worktree: not stopped, discarded or merged.
    const fresh = current().backlog.stories.find(({ id }) => id === story.id)
    if (environment?.status !== "done" || !environment.previewManifest) return
    if (!fresh || !previewStory(fresh) || fresh.worktree !== story.worktree) {
      // Back in the queue, it is prepared when it starts again.
      preparedWorktrees.delete(`${story.id}:${story.worktree}`)
      return
    }
    await workspace.prepareProjectPreview({
      executionId: started?.id ?? crypto.randomUUID(),
      storyId: story.id,
      telemetryCohorts:
        started?.telemetryCohorts ??
        storyTelemetryCohorts(story, story.agentModelId, story.agentProviderId),
      worktree: story.worktree,
      previewManifest: environment.previewManifest,
      runConfigurations: environment.runConfigurations,
      runConfigurationId: fresh.runConfigurationId,
      hostDependenciesChecked: true,
      runtimeProfile:
        story.workspaceMode === "cloud-mirror"
          ? "vercel-compose"
          : "local-container",
      databaseMode: environment.databaseMode,
    })
    setStoryPreviewWaiting(story.id, false)
    // A start that fails explains itself in the preview pane.
    if (started)
      void startRequestedPreview(current(), fresh).catch(() => undefined)
  } catch (error) {
    toast.error("Couldn't prepare the preview", {
      description: `${story.title}: ${error instanceof Error ? error.message : String(error)}`,
      position: "bottom-right",
    })
  } finally {
    setStoryPreviewWaiting(story.id, false)
  }
}

function checkedEnvironment(preparation: Preparation) {
  const model = preparation.selection.currentModel!
  return syncPreviewEnvironment({
    apiConnection: preparation.auth.apiConnection,
    platform: preparation.platform,
    projectId: preparation.project!.id,
    repositoryRoot: preparation.project!.path,
    providerId: model.provider.id,
    modelId: model.id,
    credentialLabel: model.credentialLabel,
    reasoningEffort: preparation.selection.currentVariant,
  })
}

function previewSetupWritten(
  workspace: NonNullable<Preparation["platform"]["workspace"]>,
  worktree: string
) {
  return workspace.readFile({ root: worktree, path: previewManifestPath }).then(
    () => true,
    () => false
  )
}

// A Local Container story started on a run configuration runs it at once.
async function startRequestedPreview(
  preparation: Preparation,
  story: PreviewStory
) {
  const control = preparation.platform.workspace?.controlProjectPreview
  if (story.workspaceMode !== "local-container" || !control) return
  if (typeof story.runConfigurationId !== "string") return
  const runtime = await control({
    action: "start",
    configurationId: story.runConfigurationId,
    worktree: story.worktree,
  })
  if (runtime.previewUrl) {
    await preparation.backlog.update(story, { previewUrl: runtime.previewUrl })
  }
}

function previewStory(story: UserStory): story is PreviewStory {
  return (
    (story.status === "in-progress" || story.status === "in-review") &&
    Boolean(story.worktree) &&
    (story.workspaceMode === "local-container" ||
      story.workspaceMode === "cloud-mirror")
  )
}
