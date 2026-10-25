import type { PlannedUserStory, StoryPlanMessage } from "@blame/agent-runtime"

// A planning conversation as the app keeps it: the agent's proposals are
// cards the person can edit, dismiss or add to the backlog.

export type PlanStory = PlannedUserStory & {
  // The backlog story created from this proposal.
  addedStoryId?: string
}

export type PlanMessage = {
  id: string
  role: StoryPlanMessage["role"]
  text: string
  createdAt: string
  // What the agent reads in addition to the text (attached code or files).
  context?: string
  attachments?: string[]
  stories?: PlanStory[]
  // A turn the agent did not answer; kept to retry, never sent.
  failed?: boolean
  error?: string
}

export type PlanThread = {
  messages: PlanMessage[]
  notes?: string
  updatedAt: string
}

export type CreatedStoryRef = { id: string; displayId: string; title: string }

const storageVersion = 1
const maxStoredMessages = 200

export function emptyPlanThread(): PlanThread {
  return { messages: [], updatedAt: new Date().toISOString() }
}

function storageKey(projectId: string) {
  return `blame:plan-mode:v${storageVersion}:${projectId}`
}

export function loadPlanThread(projectId: string | undefined): PlanThread {
  if (!projectId) return emptyPlanThread()
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return emptyPlanThread()
    const parsed = JSON.parse(raw) as Partial<PlanThread>
    if (!Array.isArray(parsed.messages)) return emptyPlanThread()
    return {
      messages: parsed.messages.filter(validMessage),
      notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    }
  } catch {
    return emptyPlanThread()
  }
}

export function savePlanThread(
  projectId: string | undefined,
  thread: PlanThread
) {
  if (!projectId) return
  try {
    if (!thread.messages.length) {
      localStorage.removeItem(storageKey(projectId))
      return
    }
    localStorage.setItem(
      storageKey(projectId),
      JSON.stringify({
        ...thread,
        messages: thread.messages.slice(-maxStoredMessages),
      })
    )
  } catch {
    // Storage is a convenience: the plan still works for this session.
  }
}

function validMessage(value: unknown): value is PlanMessage {
  if (!value || typeof value !== "object") return false
  const message = value as Partial<PlanMessage>
  return (
    typeof message.id === "string" &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.text === "string"
  )
}

/** The conversation the agent reads: failed turns and app fields left out. */
export function planTurnMessages(messages: PlanMessage[]): StoryPlanMessage[] {
  return messages
    .filter((message) => !message.failed)
    .map((message) => ({
      role: message.role,
      text: message.context
        ? `${message.text}\n\n${message.context}`
        : message.text,
      ...(message.stories?.length
        ? {
            stories: message.stories.map((story) => ({
              key: story.key,
              title: story.title,
              summary: story.summary,
              priority: story.priority,
              dependsOn: story.dependsOn,
              ...(story.addedAs ? { addedAs: story.addedAs } : {}),
              ...(story.dismissed ? { dismissed: true } : {}),
            })),
          }
        : {}),
    }))
}

/** The message whose proposal is the current one. */
export function latestProposalId(messages: PlanMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === "assistant" && message.stories?.length)
      return message.id
  }
  return undefined
}

export function pendingStories(stories: PlanStory[] = []) {
  return stories.filter((story) => !story.addedAs && !story.dismissed)
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

export function updatePlanStory(
  thread: PlanThread,
  messageId: string,
  key: string,
  patch: Partial<PlanStory>
): PlanThread {
  return {
    ...thread,
    messages: thread.messages.map((message) =>
      message.id === messageId
        ? {
            ...message,
            stories: message.stories?.map((story) =>
              story.key === key ? { ...story, ...patch } : story
            ),
          }
        : message
    ),
    updatedAt: new Date().toISOString(),
  }
}

/** Every proposal already added, by key, across the conversation. */
export function addedStoryRefs(messages: PlanMessage[]) {
  const refs = new Map<string, CreatedStoryRef>()
  for (const message of messages)
    for (const story of message.stories ?? [])
      if (story.addedAs && story.addedStoryId)
        refs.set(story.key, {
          id: story.addedStoryId,
          displayId: story.addedAs,
          title: story.title,
        })
  return refs
}

type CodeContext = {
  content: string
  endLine: number
  path: string
  startLine: number
}
type FileContext = {
  content?: string
  name: string
  type: string
}

const maxAttachmentCharacters = 20_000

/** Attached code and files as text the planning agent can read. */
export function planAttachmentContext(
  code: CodeContext[],
  files: FileContext[]
) {
  const blocks = [
    ...code.map(
      (item) =>
        `<code path="${item.path}" lines="${item.startLine}-${item.endLine}">\n${item.content}\n</code>`
    ),
    ...files.map((file) => {
      const text = textContent(file)
      return text
        ? `<file name="${file.name}">\n${text.slice(0, maxAttachmentCharacters)}\n</file>`
        : `<file name="${file.name}" type="${file.type}">Not readable as text.</file>`
    }),
  ]
  return {
    attachments: [
      ...code.map(
        (item) =>
          `${item.path.split("/").pop()}:${item.startLine}-${item.endLine}`
      ),
      ...files.map((file) => file.name),
    ],
    context: blocks.length
      ? `<attachments>\n${blocks.join("\n\n")}\n</attachments>`
      : undefined,
  }
}

function textContent(file: FileContext) {
  if (!file.content) return undefined
  const textual =
    file.type.startsWith("text/") ||
    /json|xml|yaml|markdown|csv/u.test(file.type) ||
    /\.(md|txt|json|ya?ml|csv|ts|tsx|js|jsx|py|go|rs|sql)$/iu.test(file.name)
  if (!textual) return undefined
  try {
    const binary = atob(file.content)
    return new TextDecoder().decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0))
    )
  } catch {
    return undefined
  }
}
