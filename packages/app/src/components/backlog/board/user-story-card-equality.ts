import type { UserStory } from "@/components/backlog/data/backlog-data"

export function equalUserStoryCardStory(
  previous: UserStory,
  next: UserStory
) {
  if (previous === next) return true
  const previousStable = stableUserStoryCardFields(previous)
  const nextStable = stableUserStoryCardFields(next)
  const keys = Object.keys(nextStable) as (keyof typeof nextStable)[]
  return (
    keys.length === Object.keys(previousStable).length &&
    keys.every((key) => previousStable[key] === nextStable[key])
  )
}

function stableUserStoryCardFields(story: UserStory) {
  // Everything a card shows comes from the story itself; its agent's
  // conversation lives in the engine and never re-renders the board.
  return story
}
