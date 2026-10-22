import { userStoryDisplayId, type UserStory } from "./backlog-data.ts"

// "Use Context" starts a new story that names the finished one. The coding
// agent then loads what it needs from it (request, outcome, changed files,
// discussion) with its story history tools, instead of carrying a snapshot.
export function completedStoryReference(
  story: Pick<UserStory, "storyNumber" | "title">
) {
  const title = story.title.trim().replace(/\s+/g, " ")
  return `Builds on ${userStoryDisplayId(story)}${title ? ` · ${title}` : ""}.\n\n`
}

/**
 * A new story's description when the person had an unfinished draft and
 * asked for context: the draft stays, the reference is added once.
 */
export function mergeDraftSummary(
  stored: string | undefined,
  initial: string | undefined
) {
  if (stored === undefined) return initial ?? ""
  const reference = initial?.trim()
  if (!reference || stored.includes(reference)) return stored
  return stored.trim() ? `${reference}\n\n${stored.trim()}` : `${reference}\n\n`
}

export function changedFilesFromDiff(diff: string) {
  return Array.from(diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm))
    .map((match) => match[2] ?? match[1])
    .filter(Boolean)
}
