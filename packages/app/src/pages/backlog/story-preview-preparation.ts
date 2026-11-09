import * as React from "react"
import { toast } from "sonner"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import type { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { setStoryPreviewWaiting } from "@/components/backlog/data/preview-environment-waits"
import { useModelSelection } from "@/components/model/model-selection"
import { useBlameRuntime } from "@/context/blame-runtime"
import {
  type CloudProjectInitialization,
  useCloudAuth,
} from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { readStoryPreviewAutoStart } from "@/lib/story-preview-auto-start"
import { storyPreviewStartsAutomatically } from "@/lib/story-preview-auto-start-decision"
import { syncPreviewEnvironment } from "./preview-environment-sync"

// A story's worktree gets its preview setup from the project's preview
// environment once that is checked against the latest commits. Until then
// its preview pane waits; its agent works meanwhile. A story is prepared
// when it starts, and again after the app quit in the middle of it.

type Preparation = {
  auth: ReturnType<typeof useCloudAuth>
  backlog: ReturnType<typeof useBacklogStore>
  platform: ReturnType<typeof usePlatform>
  project?: { id: string; path: string }
  selection: ReturnType<typeof useModelSelection>
}

type StoryStart = {
  /** The environment the story started with, if the check cannot load one. */
  environment?: CloudProjectInitialization
}

type PreviewStory = UserStory & {
  worktree: string
  workspaceMode: "local-container" | "cloud-mirror"
}

const startingStories = new Map<string, StoryStart>()
const preparing = new Set<string>()
const interruptedStorageKey = "blame.story-preview-preparations.v1"
// Written when the agent repaired the story's own setup.
const previewRepairPath = ".blame/initialization/preview-repair.json"

/** Prepares the preview of a story starting now, as part of its start. */
export function prepareStartingStoryPreview(
  storyId: string,
  start: StoryStart
) {
  startingStories.set(storyId, start)
}

/** Prepares the preview of each active story that needs it. */
export function useStoryPreviewPreparation(
  backlog: ReturnType<typeof useBacklogStore>
) {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const project = useProjects().activeProject
  // The model of the setup agents, as for a merge.
  const selection = useModelSelection({ role: "alternative" })
  // Local Container worktrees live in the Blame Runtime.
  const runtimePhase = useBlameRuntime().phase
  const runtimeReady =
    runtimePhase === "ready" || runtimePhase === "unavailable"
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
    const interrupted = readInterrupted()
    for (const key of interrupted) {
      const story = backlog.stories.find(({ id }) => key.startsWith(`${id}:`))
      // Left in progress since: a new start prepares it again.
      if (story && !(previewStory(story) && worktreeKey(story) === key))
        writeInterrupted(key, false)
    }
    for (const story of backlog.stories) {
      if (!previewStory(story)) continue
      const key = worktreeKey(story)
      const start = startingStories.get(story.id)
      if (preparing.has(key) || (!start && !interrupted.has(key))) continue
      if (story.workspaceMode === "local-container" && !runtimeReady) continue
      startingStories.delete(story.id)
      void prepareStoryPreview(current, story, start)
    }
  }, [backlog.stories, ready, runtimeReady])
}

async function prepareStoryPreview(
  current: () => Preparation,
  story: PreviewStory,
  start: StoryStart | undefined
) {
  const key = worktreeKey(story)
  preparing.add(key)
  writeInterrupted(key, true)
  setStoryPreviewWaiting(story.id, true)
  try {
    const environment =
      (await checkedEnvironment(current(), story)) ?? start?.environment
    // Still active on this worktree: not stopped, discarded or merged.
    const fresh = current().backlog.stories.find(({ id }) => id === story.id)
    const workspace = current().platform.workspace
    if (environment?.status !== "done" || !environment.previewManifest) return
    if (!fresh || !previewStory(fresh) || fresh.worktree !== story.worktree)
      return
    if (!workspace || (await fileExists(workspace, story, previewRepairPath)))
      return
    await workspace.prepareProjectPreview({
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
    void startRequestedPreview(current(), fresh).catch(() => undefined)
  } catch (error) {
    toast.error("Couldn't prepare the preview", {
      description: `${story.title}: ${error instanceof Error ? error.message : String(error)}`,
      position: "bottom-right",
    })
  } finally {
    preparing.delete(key)
    writeInterrupted(key, false)
    setStoryPreviewWaiting(story.id, false)
  }
}

function checkedEnvironment(preparation: Preparation, story: UserStory) {
  const { project, selection } = preparation
  const model = selection.currentModel
  // The project switched meanwhile: its own stories get their turn.
  if (!model || project?.id !== story.projectId) return undefined
  return syncPreviewEnvironment({
    apiConnection: preparation.auth.apiConnection,
    platform: preparation.platform,
    projectId: project.id,
    repositoryRoot: project.path,
    providerId: model.provider.id,
    modelId: model.id,
    credentialLabel: model.credentialLabel,
    reasoningEffort: selection.currentVariant,
  })
}

// A Local Container story started on a run configuration runs it at once,
// unless the person turned automatic story previews off in Settings.
async function startRequestedPreview(
  preparation: Preparation,
  story: PreviewStory
) {
  const control = preparation.platform.workspace?.controlProjectPreview
  if (story.workspaceMode !== "local-container" || !control) return
  if (typeof story.runConfigurationId !== "string") return
  if (!storyPreviewStartsAutomatically(story, readStoryPreviewAutoStart()))
    return
  const runtime = await control({
    action: "start",
    configurationId: story.runConfigurationId,
    worktree: story.worktree,
  })
  if (runtime.previewUrl) {
    await preparation.backlog.update(story, { previewUrl: runtime.previewUrl })
  }
}

function fileExists(
  workspace: NonNullable<Preparation["platform"]["workspace"]>,
  story: PreviewStory,
  path: string
) {
  return workspace.readFile({ root: story.worktree, path }).then(
    () => true,
    () => false
  )
}

function previewStory(story: UserStory): story is PreviewStory {
  return (
    (story.status === "in-progress" || story.status === "in-review") &&
    Boolean(story.worktree) &&
    (story.workspaceMode === "local-container" ||
      story.workspaceMode === "cloud-mirror")
  )
}

function worktreeKey(story: PreviewStory) {
  return `${story.id}:${story.worktree}`
}

// Preparations under way, kept so the next app session resumes those the
// app quit in the middle of.
function readInterrupted() {
  try {
    const value = JSON.parse(
      localStorage.getItem(interruptedStorageKey) ?? "[]"
    )
    return new Set<string>(Array.isArray(value) ? value : [])
  } catch {
    return new Set<string>()
  }
}

function writeInterrupted(key: string, pending: boolean) {
  const keys = readInterrupted()
  if (pending) keys.add(key)
  else keys.delete(key)
  try {
    localStorage.setItem(interruptedStorageKey, JSON.stringify([...keys]))
  } catch {
    // Without storage, a preparation the app quit in is not resumed.
  }
}
