// The steps a preview start went through, for the waiting screen. A step is
// the runtime's own step when it reports one (local previews), else its
// lifecycle phase (cloud previews). A new start attempt starts a new list.

export type PreviewStartStep = { label: string; startedAt: number }

export type PreviewStartHistory = {
  attempt?: string
  steps: PreviewStartStep[]
}

export function nextPreviewStartHistory(
  history: PreviewStartHistory,
  attempt: string | undefined,
  label: string,
  now: number
): PreviewStartHistory {
  const steps = history.attempt === attempt ? history.steps : []
  if (steps.at(-1)?.label === label) {
    return steps === history.steps ? history : { attempt, steps }
  }
  return { attempt, steps: [...steps, { label, startedAt: now }] }
}

export function formatStepDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes} min ${rest}s` : `${minutes} min`
}
