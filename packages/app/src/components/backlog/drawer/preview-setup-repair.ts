import type {
  PreviewManifest,
  ProjectInitializationDiagnostics,
  ProjectRunConfiguration,
} from "@blame/agent-runtime"
import * as React from "react"
import { toast } from "sonner"

import { useModelSelection } from "@/components/model/model-selection"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { createCloudApi } from "@/lib/cloud-api"
import { databaseModeForInitializationRepair } from "@/pages/backlog/project-initialization-database"

// A story preview can fail because the saved project setup no longer matches
// the code, for example after commits made outside Blame. This lets the user
// ask the initialization repair agent to fix the setup from the failure logs.
// The agent reads the project checkout on this machine, since a story worktree
// may live inside the runtime VM; the failure logs come from the worktree.
// The fix applies to the story worktree; merging the story saves it to the
// project, like repairs made by the development agent.

const initializationDirectory = ".blame/initialization"
const maxSetupLogLength = 24_000
const maxComposeLength = 16_000

type PreviewSetupRepairContext = {
  apiConnection: ReturnType<typeof useCloudAuth>["apiConnection"]
  platform: ReturnType<typeof usePlatform>
  projectId: string
  projectPath: string
  storyId: string
  worktree: string
  model: NonNullable<ReturnType<typeof useModelSelection>["currentModel"]>
  reasoningEffort: ReturnType<typeof useModelSelection>["currentVariant"]
}

export type PreviewSetupRepairAction = { label: string; onClick: () => void }

export function usePreviewSetupRepair(
  worktree: string | null | undefined,
  storyId: string | undefined
) {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const project = useProjects().activeProject
  const projectId = project?.id
  const projectPath = project?.path
  const selection = useModelSelection({ role: "alternative" })
  const model = selection.currentModel
  const reasoningEffort = selection.currentVariant
  return React.useCallback(
    (launchError: string): PreviewSetupRepairAction | undefined => {
      if (!worktree || !storyId || !projectId || !projectPath || !model)
        return undefined
      if (auth.status !== "authenticated") return undefined
      if (
        !platform.agent ||
        !platform.workspace?.applyProjectPreviewInitialization
      )
        return undefined
      const context: PreviewSetupRepairContext = {
        apiConnection: auth.apiConnection,
        platform,
        projectId,
        projectPath,
        storyId,
        worktree,
        model,
        reasoningEffort,
      }
      return {
        label: "Repair setup",
        onClick: () => void repairWithFeedback(context, launchError),
      }
    },
    [
      auth,
      model,
      platform,
      projectId,
      projectPath,
      reasoningEffort,
      storyId,
      worktree,
    ]
  )
}

async function repairWithFeedback(
  context: PreviewSetupRepairContext,
  launchError: string
) {
  // Sonner closes a toast after its action runs, so each pass gets its own.
  const toastId = `preview-setup-repair-${context.storyId}-${Date.now()}`
  const options = { id: toastId, position: "bottom-right" as const }
  toast.loading("Repairing preview setup", {
    ...options,
    description: "Comparing the saved setup with the current project.",
  })
  try {
    const outcome = await repairStoryPreviewSetup(context, launchError)
    if (outcome.repaired) {
      toast.success("Preview setup repaired", {
        ...options,
        description: outcome.reason,
      })
    } else {
      toast.error("Preview setup was not changed", {
        ...options,
        description: outcome.reason,
      })
    }
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error)
    // A repaired setup can fail at a later step; another pass sees that error.
    toast.error("Unable to repair preview setup", {
      ...options,
      action: {
        label: "Repair setup",
        onClick: () => void repairWithFeedback(context, description),
      },
      description,
      duration: 15_000,
    })
  }
}

async function repairStoryPreviewSetup(
  context: PreviewSetupRepairContext,
  launchError: string
) {
  const { agent, workspace } = context.platform
  if (!agent || !workspace?.applyProjectPreviewInitialization) {
    throw new Error("Preview repair is unavailable in this app.")
  }
  const setup = await currentPreviewSetup(context)
  const result = await agent.initializations.repair({
    apiConnection: context.apiConnection,
    providerId: context.model.provider.id,
    modelId: context.model.id,
    credentialLabel: context.model.credentialLabel,
    reasoningEffort: context.reasoningEffort,
    cwd: context.projectPath,
    workspaceRoot: context.projectPath,
    previewManifest: setup.previewManifest,
    runConfigurations: setup.runConfigurations,
    preferences: { database: { mode: setup.databaseMode } },
    diagnostics: await previewDiagnostics(context, launchError),
    storyId: context.storyId,
  })
  if (
    result.classification !== "repairable_initialization" ||
    !result.previewManifest ||
    !result.runConfigurations
  ) {
    return { repaired: false, reason: result.reason }
  }
  await workspace.applyProjectPreviewInitialization({
    databaseMode: setup.databaseMode,
    previewManifest: result.previewManifest,
    reason: result.reason,
    repairSessionId: result.sessionId,
    runConfigurations: result.runConfigurations,
    storyId: context.storyId,
    worktree: context.worktree,
  })
  return { repaired: true, reason: result.reason }
}

// The worktree holds the setup that actually failed, which may already differ
// from the project's saved one; the saved one is the fallback.
async function currentPreviewSetup(context: PreviewSetupRepairContext) {
  const snapshot = await createCloudApi(
    context.apiConnection
  ).projectInitialization(context.projectId)
  const saved = snapshot.initialization
  const previewManifest =
    (await readWorktreeJson<PreviewManifest>(
      context,
      "preview-manifest.json"
    )) ?? saved?.previewManifest
  const runConfigurations =
    (await readWorktreeJson<ProjectRunConfiguration[]>(
      context,
      "run-configurations.json"
    )) ?? saved?.runConfigurations
  if (!previewManifest || !runConfigurations) {
    throw new Error("This project has no preview setup to repair yet.")
  }
  const databaseMode =
    databaseModeForInitializationRepair(
      {
        previewManifest,
        runConfigurations,
        databaseMode: saved?.databaseMode ?? null,
      },
      undefined
    ) ?? "compose"
  return { previewManifest, runConfigurations, databaseMode }
}

async function previewDiagnostics(
  context: PreviewSetupRepairContext,
  launchError: string
): Promise<ProjectInitializationDiagnostics> {
  const [setupLog, composeConfig] = await Promise.all([
    readWorktreeText(context, ".blame/logs/setup.log"),
    readWorktreeText(context, `${initializationDirectory}/docker-compose.yml`),
  ])
  return {
    setupLog: setupLog.slice(-maxSetupLogLength),
    launchError,
    composeConfig: composeConfig.slice(0, maxComposeLength),
    composePs: "",
    serviceLogs: {},
  }
}

async function readWorktreeJson<T>(
  context: PreviewSetupRepairContext,
  file: string
) {
  const text = await readWorktreeText(
    context,
    `${initializationDirectory}/${file}`
  )
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

async function readWorktreeText(
  context: PreviewSetupRepairContext,
  path: string
) {
  try {
    return await context.platform.workspace!.readFile({
      root: context.worktree,
      path,
    })
  } catch {
    return ""
  }
}
