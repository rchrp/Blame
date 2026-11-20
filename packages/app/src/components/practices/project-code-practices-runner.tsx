import * as React from "react"
import { toast } from "sonner"

import { useModelSelection } from "@/components/model/model-selection"
import { codePracticeAnalysisDue } from "@/components/practices/data/code-practice-analysis-due"
import { notifyCodePracticeAnalysisUpdated } from "@/components/practices/data/code-practice-analysis-events"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { createCloudApi } from "@/lib/cloud-api"

const toastId = "project-code-practices"

export function ProjectCodePracticesRunner() {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const selection = useModelSelection({ role: "alternative" })
  const project = useProjects().activeProject

  useCodePracticeAnalysisEffect({
    engine: platform.engine,
    apiConnection: auth.apiConnection,
    authStatus: auth.status,
    model: selection.currentModel,
    project,
    reasoningEffort: selection.currentVariant,
  })
  return null
}

function useCodePracticeAnalysisEffect(selection: AnalysisSelection) {
  const { engine, apiConnection, authStatus, model, project, reasoningEffort } =
    selection
  React.useEffect(() => {
    const input = analysisInput({
      engine,
      apiConnection,
      authStatus,
      model,
      project,
      reasoningEffort,
    })
    if (!input) return
    return startCodePracticeAnalysis(input)
  }, [engine, apiConnection, authStatus, model, project, reasoningEffort])
}

function startCodePracticeAnalysis(input: Omit<AnalysisInput, "signal">) {
  const controller = new AbortController()
  void maybeAnalyzeProjectCodePractices({ ...input, signal: controller.signal })
  return () => controller.abort()
}

type AnalysisSelection = {
  engine: ReturnType<typeof usePlatform>["engine"]
  apiConnection: ReturnType<typeof useCloudAuth>["apiConnection"]
  authStatus: ReturnType<typeof useCloudAuth>["status"]
  model: ReturnType<typeof useModelSelection>["currentModel"]
  project: ReturnType<typeof useProjects>["activeProject"]
  reasoningEffort: ReturnType<typeof useModelSelection>["currentVariant"]
}

type AnalysisInput = {
  engine: NonNullable<ReturnType<typeof usePlatform>["engine"]>
  apiConnection: ReturnType<typeof useCloudAuth>["apiConnection"]
  credentialLabel?: string
  modelId: string
  project: { id: string; path: string }
  providerId: string
  reasoningEffort: ReturnType<typeof useModelSelection>["currentVariant"]
  signal: AbortSignal
}

function analysisInput(
  selection: AnalysisSelection
): Omit<AnalysisInput, "signal"> | undefined {
  const { engine, apiConnection, authStatus, model, project, reasoningEffort } =
    selection
  if (!project || !model || !engine) return
  if (authStatus !== "authenticated") return
  return {
    engine,
    apiConnection,
    credentialLabel: model.credentialLabel,
    modelId: model.id,
    project,
    providerId: model.provider.id,
    reasoningEffort,
  }
}

// Projects analyzed by this window right now. An analysis outlives the
// effect that started it (another project opened, the model changed): its
// result or failure is still saved for its own project.
const analysesHere = new Set<string>()

async function maybeAnalyzeProjectCodePractices(input: AnalysisInput) {
  const cloud = createCloudApi(input.apiConnection)
  const projectId = input.project.id
  let started = false
  try {
    const analysis = await cloud.projectCodePracticeAnalysis(projectId)
    const runningHere = analysesHere.has(projectId)
    if (input.signal.aborted || !codePracticeAnalysisDue(analysis, runningHere))
      return
    analysesHere.add(projectId)
    started = true
    await cloud.startProjectCodePracticeAnalysis(projectId, {
      providerId: input.providerId,
      modelId: input.modelId,
    })
    notifyCodePracticeAnalysisUpdated(projectId)
    await analyzeAndPersist(input, cloud)
  } catch (error) {
    if (started) await persistAnalysisError(input, cloud, error)
  } finally {
    if (started) analysesHere.delete(projectId)
    notifyCodePracticeAnalysisUpdated(projectId)
  }
}

async function analyzeAndPersist(
  input: AnalysisInput,
  cloud: ReturnType<typeof createCloudApi>
) {
  const result = await input.engine.call("analyzeCodePractices", {
    model: {
      providerId: input.providerId,
      modelId: input.modelId,
      credentialLabel: input.credentialLabel,
      reasoning: input.reasoningEffort,
    },
    projectId: input.project.id,
    workspace: { root: input.project.path },
  })
  await cloud.completeProjectCodePracticeAnalysis(input.project.id, {
    practices: result.practices,
  })
}

async function persistAnalysisError(
  input: AnalysisInput,
  cloud: ReturnType<typeof createCloudApi>,
  error: unknown
) {
  await cloud
    .failProjectCodePracticeAnalysis(input.project.id, {
      error: errorMessage(error),
    })
    .catch(() => undefined)
  if (input.signal.aborted) return
  toast.error("Code practice analysis failed", {
    description: errorMessage(error),
    id: toastId,
    position: "bottom-right",
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Unable to analyze code practices"
}
