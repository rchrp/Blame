import type { CloudProjectCodePracticeAnalysis } from "@/context/cloud-auth"
import { limitAllowsAutomaticRun } from "../../../lib/model-limit.ts"

// The status is not refreshed while an analysis runs: past this, a
// "running" one was cut off (the app quit or crashed) and runs again.
export const staleCodePracticeAnalysisMs = 30 * 60_000

// A failed analysis runs again by itself with the same model only after
// this long: the effect that starts it reruns whenever the project or the
// session refreshes, and a failure that repeats (the owner saw 11 in 12
// minutes) costs a model run each time.
export const failedCodePracticeAnalysisRetryMs = 10 * 60_000

// Whether this window should analyze the project now. One that already runs
// here is never started twice; one that finished never again; one that
// failed waits (above), and one whose model's plan is used up waits for the
// reset or another model.
export function codePracticeAnalysisDue(
  analysis: Pick<
    CloudProjectCodePracticeAnalysis,
    | "agentModelId"
    | "agentProviderId"
    | "createdAt"
    | "error"
    | "status"
    | "updatedAt"
  >,
  runningHere: boolean,
  model: { providerId: string; modelId: string },
  now = Date.now()
) {
  if (runningHere || analysis.status === "done") return false
  const reportedAt = Date.parse(analysis.updatedAt ?? analysis.createdAt)
  if (analysis.status === "error")
    return failedAnalysisDue(analysis, reportedAt, model, now)
  if (analysis.status !== "running") return true
  return (
    !Number.isFinite(reportedAt) ||
    now - reportedAt > staleCodePracticeAnalysisMs
  )
}

function failedAnalysisDue(
  analysis: Pick<
    CloudProjectCodePracticeAnalysis,
    "agentModelId" | "agentProviderId" | "error"
  >,
  failedAt: number,
  model: { providerId: string; modelId: string },
  now: number
) {
  if (!Number.isFinite(failedAt)) return true
  const failedModel = {
    providerId: analysis.agentProviderId,
    modelId: analysis.agentModelId,
  }
  if (
    !limitAllowsAutomaticRun({
      error: analysis.error,
      failedAt,
      failedModel,
      model,
      now,
    })
  )
    return false
  const sameModel =
    failedModel.providerId === model.providerId &&
    failedModel.modelId === model.modelId
  return !sameModel || now - failedAt >= failedCodePracticeAnalysisRetryMs
}
