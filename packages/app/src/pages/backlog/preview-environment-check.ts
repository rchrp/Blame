type Commit = { hash: string; date: string }

/**
 * The commit to compare the project branch with: the one the preview
 * environment was last checked against. For an environment saved before
 * Blame recorded it, or whose commit left the branch: the newest commit made
 * no later than its last save, else a commit known to precede the head (the
 * base of a merge). Undefined when there is nothing to compare: no history,
 * no such commit, or no commit since.
 */
export function previewEnvironmentCheckBase(
  history: Commit[],
  environment: { checkedCommit?: string | null; updatedAt: string | null },
  fallback?: string
) {
  const head = history[0]?.hash
  if (!head) return undefined
  const checked = environment.checkedCommit
  const base =
    checked && history.some(({ hash }) => hash === checked)
      ? checked
      : (commitAt(history, environment.updatedAt) ?? fallback)
  return base && base !== head ? base : undefined
}

function commitAt(history: Commit[], savedAt: string | null) {
  const saved = savedAt ? Date.parse(savedAt) : Number.NaN
  if (Number.isNaN(saved)) return undefined
  return history.find(({ date }) => Date.parse(date) <= saved)?.hash
}
