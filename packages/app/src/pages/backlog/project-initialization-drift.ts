import type { ReasoningSelection } from "@blame/agent-runtime"
import { toast } from "sonner"

import type { CloudProjectInitialization } from "@/context/cloud-auth"
import type { useCloudAuth } from "@/context/cloud-auth"
import type { usePlatform } from "@/context/platform"
import { createCloudApi } from "@/lib/cloud-api"
import { initializationDriftRange } from "./project-initialization-drift-reference"
import { assessAndRepairProjectInitializationImpact } from "./project-initialization-impact"

// Blame reassesses the project initialization when one of its stories
// merges, but commits made outside Blame never trigger that check, and the
// preview setup silently goes stale (a dev script that starts Docker, new
// migrations...). Before a story starts, compare the project with the commit
// the initialization was last saved against and reassess when they differ.
// Unchanged runtime files are settled without a model call.

const checkedStoragePrefix = "blame.initialization-drift-checked.v1:"
const historyLimit = 500
const progressToastDelay = 1500
const inFlight = new Map<string, Promise<CloudProjectInitialization>>()

type DriftInput = {
  apiConnection: ReturnType<typeof useCloudAuth>["apiConnection"]
  platform: ReturnType<typeof usePlatform>
  projectId: string
  repositoryRoot: string
  initialization: CloudProjectInitialization
  providerId: string
  modelId: string
  credentialLabel?: string
  reasoningEffort?: ReasoningSelection
}

/** Returns the initialization to start the story with. */
export function refreshDriftedProjectInitialization(input: DriftInput) {
  const current = inFlight.get(input.projectId)
  if (current) return current
  const check = checkProjectInitializationDrift(input).finally(() =>
    inFlight.delete(input.projectId)
  )
  inFlight.set(input.projectId, check)
  return check
}

async function checkProjectInitializationDrift(input: DriftInput) {
  const workspace = input.platform.workspace
  const savedAt = input.initialization.updatedAt
  if (!workspace || !input.platform.agent || !savedAt)
    return input.initialization
  const history = await workspace
    .gitLog({
      root: input.repositoryRoot,
      limit: historyLimit,
      currentBranchOnly: true,
    })
    .catch(() => [])
  const head = history[0]?.hash
  if (!head) return input.initialization
  const checkKey = `${savedAt}:${head}`
  if (driftChecked(input.projectId, checkKey)) return input.initialization
  const range = initializationDriftRange(history, savedAt)
  if (!range) {
    markDriftChecked(input.projectId, checkKey)
    return input.initialization
  }
  const toastId = `project-initialization-drift-${input.projectId}`
  const progress = setTimeout(() => {
    toast.loading("Checking the preview setup", {
      id: toastId,
      description:
        "Comparing it with commits made since the project was set up.",
      position: "bottom-right",
    })
  }, progressToastDelay)
  try {
    const result = await assessAndRepairProjectInitializationImpact({
      apiConnection: input.apiConnection,
      platform: input.platform,
      projectId: input.projectId,
      providerId: input.providerId,
      modelId: input.modelId,
      credentialLabel: input.credentialLabel,
      reasoningEffort: input.reasoningEffort,
      repositoryRoot: input.repositoryRoot,
      ...range,
    })
    markDriftChecked(input.projectId, checkKey)
    if (result?.repair?.classification !== "repairable_initialization") {
      toast.dismiss(toastId)
      return input.initialization
    }
    toast.success("Preview setup updated", {
      id: toastId,
      description: "It now matches commits made since the project was set up.",
      position: "bottom-right",
    })
    const snapshot = await createCloudApi(
      input.apiConnection
    ).projectInitialization(input.projectId)
    return snapshot.initialization ?? input.initialization
  } catch (error) {
    // The story still starts with the saved setup; a failing preview offers
    // "Repair setup" later.
    toast.warning("Could not check the preview setup", {
      id: toastId,
      description: error instanceof Error ? error.message : String(error),
      position: "bottom-right",
    })
    return input.initialization
  } finally {
    clearTimeout(progress)
  }
}

function driftChecked(projectId: string, key: string) {
  try {
    return localStorage.getItem(checkedStoragePrefix + projectId) === key
  } catch {
    return false
  }
}

function markDriftChecked(projectId: string, key: string) {
  try {
    localStorage.setItem(checkedStoragePrefix + projectId, key)
  } catch {
    // Without storage the check simply runs again next time.
  }
}
