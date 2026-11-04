import type { PreviewManifest, ReasoningSelection } from "@blame/agent-runtime"
import { toast } from "sonner"

import type {
  CloudProjectInitialization,
  useCloudAuth,
} from "@/context/cloud-auth"
import type { usePlatform } from "@/context/platform"
import { createCloudApi } from "@/lib/cloud-api"
import { previewEnvironmentCheckBase } from "./preview-environment-check"
import type { ProjectPreviewRepairCandidate } from "./project-initialization-database"
import {
  assessAndRepairProjectInitializationImpact,
  type ProjectInitializationImpactRepairResult,
} from "./project-initialization-impact"

// The preview environment records the last commit of the project branch it
// was checked against. Once the branch has moved (a story merged, commits
// made outside Blame), the impact agent looks at the commits in between and
// the repair agent updates the environment when they need it. A merge checks
// right away; a story preview waits for the check, its agent never does.
// A check that does not settle (an error, an update the repair could not
// make) records nothing: it runs again on a new commit or a new app session.

export type PreviewEnvironmentSyncInput = {
  apiConnection: ReturnType<typeof useCloudAuth>["apiConnection"]
  platform: ReturnType<typeof usePlatform>
  projectId: string
  repositoryRoot: string
  providerId: string
  modelId: string
  credentialLabel?: string
  reasoningEffort?: ReasoningSelection
  /** The merged story's own repair of the environment, if it made one. */
  previewRepairCandidate?: ProjectPreviewRepairCandidate
  /** A commit known to precede the head: the base of a merge. */
  fallbackBase?: string
}

type SyncResult = Promise<CloudProjectInitialization | undefined>
type ReadyEnvironment = CloudProjectInitialization & {
  previewManifest: PreviewManifest
}

const historyLimit = 500
const progressToastDelay = 1500
const position = "bottom-right" as const

// One check runs per project at a time. The next one waits its turn and
// reads the branch only when it starts, so it answers every request made
// meanwhile.
type QueuedCheck = { input: PreviewEnvironmentSyncInput; result: SyncResult }
const queues = new Map<string, { last: SyncResult; next?: QueuedCheck }>()
// The head of each project whose check did not settle in this session.
const unsettledHeads = new Map<string, string>()

/** The project's preview environment, checked against its branch head. */
export function syncPreviewEnvironment(
  input: PreviewEnvironmentSyncInput
): SyncResult {
  const queue = queues.get(input.projectId) ?? {
    last: Promise.resolve(undefined),
  }
  queues.set(input.projectId, queue)
  if (queue.next) {
    if (input.previewRepairCandidate) queue.next.input = input
    return queue.next.result
  }
  const next = { input } as QueuedCheck
  next.result = queue.last
    .catch(() => undefined)
    .then(() => {
      queue.next = undefined
      return checkPreviewEnvironment(next.input)
    })
  queue.next = next
  queue.last = next.result
  return next.result
}

// Never rejects: without a check, previews run with the saved environment
// and a failing one offers "Repair setup".
async function checkPreviewEnvironment(input: PreviewEnvironmentSyncInput) {
  const toastId = `preview-environment-check-${input.projectId}`
  let saved: CloudProjectInitialization | undefined
  let headCommit: string | undefined
  try {
    const cloud = createCloudApi(input.apiConnection)
    saved =
      (await cloud.projectInitialization(input.projectId)).initialization ??
      undefined
    const workspace = input.platform.workspace
    if (!isReady(saved) || !workspace || !input.platform.agent) return saved
    // An API too old to record checks sends no checkedCommit at all.
    if (saved.checkedCommit === undefined) return saved
    const branch = { root: input.repositoryRoot, currentBranchOnly: true }
    const [head] = await workspace.gitLog({ ...branch, limit: 1 })
    if (!head || head.hash === saved.checkedCommit) return saved
    if (unsettledHeads.get(input.projectId) === head.hash) return saved
    const history = await workspace.gitLog({ ...branch, limit: historyLimit })
    headCommit = history[0]?.hash ?? head.hash
    const baseCommit = previewEnvironmentCheckBase(
      history,
      saved,
      input.fallbackBase
    )
    // Nothing on the branch to compare with: the environment stands as is.
    if (!baseCommit) return await recordCheck(input, headCommit, saved)
    return await checkCommits(input, saved, baseCommit, headCommit, toastId)
  } catch (error) {
    if (headCommit) unsettledHeads.set(input.projectId, headCommit)
    toast.warning("Could not check the preview environment", {
      id: toastId,
      description: error instanceof Error ? error.message : String(error),
      position,
    })
    return saved
  }
}

async function checkCommits(
  input: PreviewEnvironmentSyncInput,
  saved: ReadyEnvironment,
  baseCommit: string,
  headCommit: string,
  toastId: string
) {
  // A check settled without the agents leaves no toast behind.
  let progressShown = false
  const progress = setTimeout(() => {
    progressShown = true
    toast.loading("Checking the preview environment", {
      id: toastId,
      description: "Looking at the commits made since its last check.",
      position,
    })
  }, progressToastDelay)
  try {
    const result = await assessAndRepairProjectInitializationImpact({
      ...input,
      initialization: saved,
      baseCommit,
      headCommit,
    })
    showCheckResult(toastId, result, progressShown)
    // A repair saves the head as checked.
    if (result.repaired) return result.repaired
    if (result.assessment.classification === "initialization_update_required") {
      unsettledHeads.set(input.projectId, headCommit)
      return saved
    }
    return await recordCheck(input, headCommit, saved)
  } finally {
    clearTimeout(progress)
  }
}

async function recordCheck(
  input: PreviewEnvironmentSyncInput,
  commit: string,
  saved: CloudProjectInitialization
) {
  const snapshot = await createCloudApi(
    input.apiConnection
  ).checkProjectInitialization(input.projectId, { commit })
  return snapshot.initialization ?? saved
}

function showCheckResult(
  toastId: string,
  result: ProjectInitializationImpactRepairResult,
  progressShown: boolean
) {
  const options = { id: toastId, position }
  const verdict =
    result.repair?.classification ?? result.assessment.classification
  if (result.repaired) {
    toast.success("Preview environment updated", {
      ...options,
      description: "It now matches the latest commits.",
    })
  } else if (
    verdict === "initialization_still_valid" ||
    verdict === "unknown"
  ) {
    if (!progressShown) return void toast.dismiss(toastId)
    const unconfirmed = verdict === "unknown"
    toast.info(
      unconfirmed
        ? "Preview environment kept unchanged"
        : "Preview environment already up to date",
      {
        ...options,
        description: unconfirmed
          ? "The check did not confirm a needed update. Your current configuration was kept."
          : "Your current configuration still fits the latest commits.",
      }
    )
  } else if (result.repair) {
    toast.error("Preview environment update failed", {
      ...options,
      description: result.repair.reason,
    })
  } else {
    toast.dismiss(toastId)
  }
}

function isReady(
  environment: CloudProjectInitialization | undefined
): environment is ReadyEnvironment {
  return environment?.status === "done" && Boolean(environment.previewManifest)
}
