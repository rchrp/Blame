import type { PlannedUserStory, StoryPlanPriority } from "@blame/agent-runtime"

import type { UserStoryAgentActivity } from "@/components/backlog/data/backlog-data"
import type { AgentConversationRun } from "@/components/chat/agent-conversation"

// Tools whose call is shown as a card in the conversation, next to the
// agent's reply, instead of a step of its work.

export const storyProposalToolName = "propose_user_stories"
export const projectStackProposalToolName = "propose_project_stack"
const proposalToolNames = new Set([
  storyProposalToolName,
  projectStackProposalToolName,
])

export function isProposalActivity(
  activity: Pick<UserStoryAgentActivity, "kind" | "toolName"> | undefined
) {
  return Boolean(
    activity?.kind === "tool" &&
    activity.toolName &&
    proposalToolNames.has(activity.toolName)
  )
}

/** Identifies one proposal across the app, for the person's decisions. */
export function proposalId(
  run: Pick<AgentConversationRun, "id">,
  activity: Pick<UserStoryAgentActivity, "id" | "toolCallId">
) {
  return `${run.id}:${activity.toolCallId ?? activity.id}`
}

/** The story proposals of a conversation, oldest first. */
export function storyProposalIds(runs: AgentConversationRun[]) {
  return runs.flatMap((run) =>
    (run.activities ?? [])
      .filter(
        (activity) =>
          activity.toolName === storyProposalToolName &&
          activity.status === "completed"
      )
      .map((activity) => proposalId(run, activity))
  )
}

type ToolDetail = { input?: unknown; output?: unknown }

/** The tool call's detail, unless the stream compacted it. */
export function fullToolDetail(detail: string): ToolDetail | undefined {
  try {
    const parsed = JSON.parse(detail) as ToolDetail
    if (!parsed || typeof parsed !== "object" || compacted(parsed.input))
      return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function proposedStories(detail: ToolDetail): PlannedUserStory[] {
  const input = record(detail.input)
  const stories = Array.isArray(input.stories) ? input.stories : []
  return stories.flatMap((value, index) => {
    const story = record(value)
    const title = text(story.title)
    const summary = text(story.summary)
    if (!title || !summary) return []
    return [
      {
        key: text(story.key) || `P${index + 1}`,
        title,
        summary,
        priority: priority(story.priority),
        dependsOn: Array.isArray(story.dependsOn)
          ? story.dependsOn.filter(
              (key): key is string => typeof key === "string"
            )
          : [],
        attachments: Array.isArray(story.attachments)
          ? Array.from(new Set(story.attachments.map(text).filter(Boolean)))
          : [],
      },
    ]
  })
}

/** The validated configuration the stack tool returned. */
export function proposedConfiguration(detail: ToolDetail): unknown {
  const output = record(detail.output)
  const nested = record(output.output)
  return record(output.configuration ? output : nested).configuration
}

function compacted(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) return value.some(compacted)
  const item = value as Record<string, unknown>
  if (item.truncated === true && typeof item.excerpt === "string") return true
  return Object.values(item).some(compacted)
}

function priority(value: unknown): StoryPlanPriority {
  return value === "High" || value === "Low" ? value : "Medium"
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
