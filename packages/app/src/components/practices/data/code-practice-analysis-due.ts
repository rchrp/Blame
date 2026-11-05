import type { CloudProjectCodePracticeAnalysis } from "@/context/cloud-auth"

// The status is not refreshed while an analysis runs: past this, a
// "running" one was cut off (the app quit or crashed) and runs again.
export const staleCodePracticeAnalysisMs = 30 * 60_000

// Whether this window should analyze the project now. One that already runs
// here is never started twice; one that finished never again.
export function codePracticeAnalysisDue(
  analysis: Pick<
    CloudProjectCodePracticeAnalysis,
    "createdAt" | "status" | "updatedAt"
  >,
  runningHere: boolean,
  now = Date.now()
) {
  if (runningHere || analysis.status === "done") return false
  if (analysis.status !== "running") return true
  const reportedAt = Date.parse(analysis.updatedAt ?? analysis.createdAt)
  return (
    !Number.isFinite(reportedAt) ||
    now - reportedAt > staleCodePracticeAnalysisMs
  )
}
