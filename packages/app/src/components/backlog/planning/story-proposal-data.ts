import type { PlannedUserStory } from "@blame/agent-runtime"

import type {
  UserStoryDraft,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"

// User stories an agent proposed in a conversation (plan mode, a chat, a
// user story). They are cards the person can edit, dismiss or add to the
// backlog; nothing is created until they do.

export type PlanStory = PlannedUserStory & {
  // The backlog story created from this proposal.
  addedStoryId?: string
}

/** What the person changed on a card, kept per proposal and story key. */
export type PlanStoryDecision = Partial<
  Pick<
    PlanStory,
    "addedAs" | "addedStoryId" | "dismissed" | "priority" | "summary" | "title"
  >
>
export type PlanStoryEdit = Pick<
  PlanStoryDecision,
  "priority" | "summary" | "title"
>

export type CreatedStoryRef = { id: string; displayId: string; title: string }

export function pendingStories(stories: PlanStory[] = []) {
  return stories.filter((story) => !story.addedAs && !story.dismissed)
}

/** The proposal as the person sees it: the agent's stories and their edits. */
export function decidedStories(
  stories: PlannedUserStory[],
  decisions: Record<string, PlanStoryDecision> = {}
): PlanStory[] {
  return stories.map((story) => ({ ...story, ...decisions[story.key] }))
}

/**
 * The stories to create so that `keys` can be added: their proposals that
 * are not in the backlog yet come first, dependencies before dependents.
 */
export function storiesToAdd(stories: PlanStory[], keys: string[]) {
  const byKey = new Map(stories.map((story) => [story.key, story]))
  const ordered: PlanStory[] = []
  const visiting = new Set<string>()
  const visit = (key: string) => {
    const story = byKey.get(key)
    if (!story || story.addedAs || visiting.has(key)) return
    if (ordered.includes(story)) return
    visiting.add(key)
    for (const dependency of story.dependsOn) visit(dependency)
    visiting.delete(key)
    ordered.push(story)
  }
  for (const key of keys) visit(key)
  return ordered
}

/** Keys of the proposals that `key` needs and that are not in the backlog. */
export function missingDependencies(stories: PlanStory[], key: string) {
  return storiesToAdd(stories, [key])
    .map((story) => story.key)
    .filter((dependency) => dependency !== key)
}

/**
 * The story description the coding agent receives, with its dependencies
 * named by their backlog ids so the agent can look them up.
 */
export function plannedStoryMarkdown(
  story: PlanStory,
  resolve: (
    key: string
  ) => Pick<CreatedStoryRef, "displayId" | "title"> | undefined
) {
  const dependencies = story.dependsOn
    .map((key) => {
      if (/^US-\d+$/u.test(key)) return { displayId: key, title: undefined }
      return resolve(key)
    })
    .filter((item): item is { displayId: string; title: string | undefined } =>
      Boolean(item)
    )
  if (!dependencies.length) return story.summary.trim()
  return [
    story.summary.trim(),
    "",
    "## Depends on",
    ...dependencies.map(
      ({ displayId, title }) =>
        `- ${displayId}${title ? ` · ${title}` : ""} (to be merged first)`
    ),
  ].join("\n")
}

/** The conversation's files that a proposed story names, each once. */
export function storyFileAttachments(
  story: Pick<PlannedUserStory, "attachments">,
  available: UserStoryFileAttachment[]
) {
  const files: UserStoryFileAttachment[] = []
  for (const name of story.attachments) {
    // When a name was attached twice, the latest upload is the one meant.
    const file = available.findLast((item) => item.name === name)
    if (file && !files.includes(file)) files.push(file)
  }
  return files
}

/** The backlog story that adding a proposal creates, with the files it carries. */
export function plannedStoryDraft(
  story: PlanStory,
  resolve: Parameters<typeof plannedStoryMarkdown>[1],
  available: UserStoryFileAttachment[]
): Omit<UserStoryDraft, "projectId"> {
  const fileAttachments = storyFileAttachments(story, available)
  return {
    title: story.title,
    summary: plannedStoryMarkdown(story, resolve),
    priority: story.priority,
    status: "backlog",
    ...(fileAttachments.length ? { fileAttachments } : {}),
  }
}

/** Stories added from earlier proposals, by key (latest wins). */
export function addedStoryRefs(proposals: PlanStory[][]) {
  const refs = new Map<string, CreatedStoryRef>()
  for (const stories of proposals)
    for (const story of stories)
      if (story.addedAs && story.addedStoryId)
        refs.set(story.key, {
          id: story.addedStoryId,
          displayId: story.addedAs,
          title: story.title,
        })
  return refs
}

/**
 * What the person did with a proposal, for the agent's next turn: it only
 * sees its own tool call otherwise.
 */
export function proposalDecisionsNote(stories: PlanStory[]) {
  const lines = stories.flatMap((story) =>
    story.addedAs
      ? [`- ${story.key} added to the backlog as ${story.addedAs}`]
      : story.dismissed
        ? [`- ${story.key} dismissed`]
        : []
  )
  if (!lines.length) return undefined
  return `<proposal_decisions>\nWhat I did with your latest proposed stories:\n${lines.join("\n")}\n</proposal_decisions>`
}
