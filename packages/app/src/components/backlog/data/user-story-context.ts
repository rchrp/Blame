import {
  userStoryDisplayId,
  type UserStory,
  type UserStoryCodeSelectionAttachment,
} from "./backlog-data.ts"

// "Use Context" starts a new story that names the finished one. The coding
// agent then loads what it needs from it (request, outcome, changed files,
// discussion) with its story history tools, instead of carrying a snapshot.
// "Use Context" starts a new story with the finished one attached. The
// coding agent then loads what it needs from it (request, outcome, changed
// files, discussion) with its story history tools, instead of carrying a
// snapshot. One story is attached once, whatever its title became.
export function storyContextAttachment(
  story: Pick<UserStory, "id" | "storyNumber" | "title">
): UserStoryCodeSelectionAttachment {
  return {
    id: `story-context:${story.id}`,
    content: story.title.trim().replace(/\s+/g, " "),
    endLine: 1,
    origin: "story",
    path: userStoryDisplayId(story),
    startLine: 1,
    storyId: story.id,
  }
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
