import type {
  AssessProjectInitializationImpactResult,
  PreviewManifest,
  ProjectInitializationDatabaseMode,
  ProjectRunConfiguration,
  ReasoningSelection,
  RepairProjectInitializationResult,
} from "@blame/agent-runtime"

import type {
  CloudProjectInitialization,
  useCloudAuth,
} from "@/context/cloud-auth"
import type { usePlatform } from "@/context/platform"
import { createCloudApi } from "@/lib/cloud-api"
import { notifyProjectInitializationUpdated } from "@/components/project-initialization/project-initialization-events"
import { databaseModeForInitializationRepair } from "./project-initialization-database"
import { previewRepairCandidateMatchesDiff } from "./project-initialization-database"
import type { ProjectPreviewRepairCandidate } from "./project-initialization-database"

type ImpactInput = {
  apiConnection: ReturnType<typeof useCloudAuth>["apiConnection"]
  platform: ReturnType<typeof usePlatform>
  projectId: string
  providerId: string
  modelId: string
  credentialLabel?: string
  reasoningEffort?: ReasoningSelection
  repositoryRoot: string
  /** The saved preview environment. */
  initialization: CurrentInitialization
  /** The commit it was last checked against. */
  baseCommit: string
  /** The commit the project branch is at now. */
  headCommit: string
  previewRepairCandidate?: ProjectPreviewRepairCandidate
}

export type ProjectInitializationImpactRepairResult = {
  assessment: AssessProjectInitializationImpactResult
  repair?: RepairProjectInitializationResult
  /** The saved environment once a repair updated it. */
  repaired?: CloudProjectInitialization
}

/**
 * Asks the impact agent whether the commits between the two change what the
 * preview environment needs, and when they do, repairs it (with the merged
 * story's own repair when it still applies) and saves it as checked at
 * the head commit.
 */
export async function assessAndRepairProjectInitializationImpact(
  input: ImpactInput
): Promise<ProjectInitializationImpactRepairResult> {
  const assessment = await assessProjectInitializationImpact(input)
  if (assessment.classification !== "initialization_update_required") {
    return { assessment }
  }
  const candidate = await matchingPreviewRepairCandidate(input)
  const repair = candidate
    ? candidateRepairResult(candidate)
    : await repairProjectInitializationImpact(input, assessment)
  const databaseMode =
    candidate?.databaseMode ??
    databaseModeForInitializationRepair(
      input.initialization,
      assessment.diagnostics
    )
  const repaired = await persistProjectInitializationRepair(
    input,
    repair,
    databaseMode
  )
  return { assessment, repair, repaired }
}

async function matchingPreviewRepairCandidate(input: ImpactInput) {
  const candidate = input.previewRepairCandidate
  const workspace = input.platform.workspace
  if (!candidate || !workspace) return undefined
  const diff = await workspace.gitDiffBetween({
    from: candidate.sourceTree,
    root: input.repositoryRoot,
    to: input.headCommit,
  })
  return previewRepairCandidateMatchesDiff(diff) ? candidate : undefined
}

function candidateRepairResult(
  candidate: ProjectPreviewRepairCandidate
): RepairProjectInitializationResult {
  return {
    sessionId: candidate.repairSessionId,
    classification: "repairable_initialization",
    reason: candidate.reason,
    previewManifest: candidate.previewManifest,
    runConfigurations: candidate.runConfigurations,
  }
}

async function assessProjectInitializationImpact(input: ImpactInput) {
  const agent = input.platform.agent
  if (!agent) throw new Error("Initialization impact runtime is unavailable.")
  return agent.initializations.assessImpact({
    apiConnection: input.apiConnection,
    providerId: input.providerId,
    modelId: input.modelId,
    credentialLabel: input.credentialLabel,
    reasoningEffort: input.reasoningEffort,
    cwd: input.repositoryRoot,
    workspaceRoot: input.repositoryRoot,
    baseCommit: input.baseCommit,
    mergeCommit: input.headCommit,
    previewManifest: input.initialization.previewManifest,
    runConfigurations: input.initialization.runConfigurations,
  })
}

async function repairProjectInitializationImpact(
  input: ImpactInput,
  assessment: AssessProjectInitializationImpactResult
) {
  const initialization = input.initialization
  const agent = input.platform.agent
  if (!agent) throw new Error("Initialization repair runtime is unavailable.")
  if (!assessment.diagnostics) {
    throw new Error(
      "Initialization impact assessment did not include diagnostics."
    )
  }
  const databaseMode = databaseModeForInitializationRepair(
    initialization,
    assessment.diagnostics
  )
  return agent.initializations.repair({
    apiConnection: input.apiConnection,
    providerId: input.providerId,
    modelId: input.modelId,
    credentialLabel: input.credentialLabel,
    reasoningEffort: input.reasoningEffort,
    cwd: input.repositoryRoot,
    workspaceRoot: input.repositoryRoot,
    previewManifest: initialization.previewManifest,
    runConfigurations: initialization.runConfigurations,
    preferences: databaseMode
      ? { database: { mode: databaseMode } }
      : undefined,
    diagnostics: assessment.diagnostics,
  })
}

async function persistProjectInitializationRepair(
  input: ImpactInput,
  result: RepairProjectInitializationResult,
  databaseMode: ProjectInitializationDatabaseMode | undefined
) {
  if (result.classification !== "repairable_initialization") return undefined
  if (!result.previewManifest || !result.runConfigurations) {
    throw new Error(
      "Initialization repair agent returned incomplete artifacts."
    )
  }
  const snapshot = await createCloudApi(
    input.apiConnection
  ).repairProjectInitialization(input.projectId, {
    clineSessionId: result.sessionId,
    previewManifest: result.previewManifest,
    runConfigurations: result.runConfigurations,
    databaseMode: databaseMode ?? null,
    reason: result.reason,
    checkedCommit: input.headCommit,
  })
  notifyProjectInitializationUpdated(input.projectId)
  return snapshot.initialization ?? undefined
}

type CurrentInitialization = {
  previewManifest: PreviewManifest
  runConfigurations: ProjectRunConfiguration[]
  databaseMode: ProjectInitializationDatabaseMode | null
}
