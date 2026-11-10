import type { UserStory } from "@/components/backlog/data/backlog-data"
import type { Platform } from "@/context/platform"

// The message that resumes an interrupted agent from its existing worktree.
export function resumeAgentFeedback(story: UserStory, diffSummary: string) {
  const details = [
    story.agentSessionSummary
      ? `Previous session summary:\n${story.agentSessionSummary}`
      : "",
    story.agentLastError ? `Previous agent error: ${story.agentLastError}` : "",
    story.agentLastEvent ? `Last recorded event: ${story.agentLastEvent}` : "",
    diffSummary,
  ].filter(Boolean)
  return [
    "Resume the implementation from the existing worktree.",
    "Inspect the current git diff first, keep the useful existing changes, and continue until the story is ready for review.",
    ...details,
  ].join("\n")
}

export async function currentDiffSummary(story: UserStory, platform: Platform) {
  if (!story.worktree || !platform.workspace) return ""
  try {
    const diff = await platform.workspace.gitDiff({ root: story.worktree })
    return diffSummary(diff)
  } catch {
    return ""
  }
}

function diffSummary(diff: string) {
  const files = Array.from(diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm))
    .map((match) => match[2])
    .filter(Boolean)
    .slice(0, 20)
  if (files.length === 0) return "Current git diff: no local changes."
  return `Current git diff files: ${files.join(", ")}.`
}
