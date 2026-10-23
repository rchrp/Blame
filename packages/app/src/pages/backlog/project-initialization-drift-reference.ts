// The commit an initialization was last saved against: the newest commit of
// the project branch made no later than the save. Undefined when the history
// does not reach back that far or nothing changed since.
export function initializationDriftRange(
  history: { hash: string; date: string }[],
  savedAt: string
) {
  const head = history[0]?.hash
  const saved = Date.parse(savedAt)
  if (!head || Number.isNaN(saved)) return undefined
  const reference = history.find(({ date }) => Date.parse(date) <= saved)?.hash
  if (!reference || reference === head) return undefined
  return { baseCommit: reference, mergeCommit: head }
}
