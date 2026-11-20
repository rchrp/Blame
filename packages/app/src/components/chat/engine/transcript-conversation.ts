// What the shared conversation timeline shows, from an engine session's
// transcript (TranscriptReducer of @blame/engine-client). The only place
// that knows both shapes: the timeline was written for the Cline runtime's
// runs and activities, which stories still use.

import type {
  ToolCallItem,
  Transcript,
  TranscriptItem,
  TurnView,
  UsageTotals,
  UserItem,
} from "@blame/engine-client/transcript"
import { appProviderId } from "@blame/agent-runtime/engine-protocol"

import type {
  UserStoryAgentActivity,
  UserStoryAgentRunStatus,
  UserStoryAgentUsage,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import type {
  AgentConversationComment,
  AgentConversationRun,
} from "@/components/chat/agent-conversation"

export type TranscriptConversation = {
  comments: AgentConversationComment[]
  runs: AgentConversationRun[]
  /** Where each message can be undone to, by the comment (user item) key. */
  rewindTargets: ReadonlyMap<string, { to: number; workspace: boolean }>
}

export function transcriptConversation(
  transcript: Transcript,
  author: string,
  options: {
    /** The first turn answers a brief shown elsewhere (a story's request), not a message. */
    brief?: boolean
  } = {}
): TranscriptConversation {
  const comments: AgentConversationComment[] = []
  const rewindTargets = new Map<string, { to: number; workspace: boolean }>()
  const itemsByTurn = new Map<string, TranscriptItem[]>()
  for (const item of transcript.items) {
    if (!("turn" in item)) continue
    const items = itemsByTurn.get(item.turn) ?? []
    items.push(item)
    itemsByTurn.set(item.turn, items)
  }
  let checkpoints = 0
  const runs: AgentConversationRun[] = []
  // A turn changed what lies between its snapshot and the next one's (the
  // files now, for the last).
  const snapshots = new Map(transcript.checkpoints.map((checkpoint) => [checkpoint.turn, checkpoint.snapshot]))
  const kept = transcript.turns.filter((turn) => turn.status !== "rewound")
  for (const [index, turn] of kept.entries()) {
    const brief = options.brief && runs.length === 0
    const items = itemsByTurn.get(turn.turn) ?? []
    const opening = items.find(
      (item) => item.kind === "user" && item.delivery === "turn"
    )
    if (opening?.kind === "user") {
      comments.push({
        author,
        body: userText(opening.blocks),
        createdAt: iso(opening.atMs),
        fileAttachments: userFiles(opening.blocks, opening.key),
        id: opening.key,
      })
      if (opening.rewind) rewindTargets.set(opening.key, opening.rewind)
    }
    const activities = turnActivities(transcript, turn, items, author)
    const model = items.find(
      (item) => (item.kind === "text" || item.kind === "tool_call") && item.message?.model
    )
    const modelRef =
      model && "message" in model ? model.message?.model : transcript.config?.model
    const final = activities.findLast(
      (activity) => activity.kind === "message" && activity.messageKind === "final"
    )
    runs.push({
      activities,
      // Turns that can be undone count as checkpoints for the timeline.
      checkpointRunCount: opening?.kind === "user" && opening.rewind ? ++checkpoints : null,
      commentId: opening?.key ?? null,
      completedAt: turn.endedAtMs ? iso(turn.endedAtMs) : null,
      createdAt: iso(turn.startedAtMs),
      diffStartRef: snapshots.get(turn.turn) ?? null,
      diffEndRef: kept.slice(index + 1).map((next) => snapshots.get(next.turn)).find(Boolean) ?? null,
      finalResponse: final?.detail ?? null,
      id: turn.turn,
      kind: brief ? "initial" : "change-request",
      modelId: modelRef?.model ?? null,
      providerId: modelRef ? appProviderId(modelRef.provider) : null,
      reasoningEffort: transcript.config?.reasoning ?? null,
      status: runStatus(turn),
      usage: agentUsage(turn.usage, transcript.usage.spent),
    })
  }
  return { comments, rewindTargets, runs }
}

function runStatus(turn: TurnView): UserStoryAgentRunStatus {
  switch (turn.status) {
    case "queued":
      return "pending"
    case "running":
      return "running"
    case "completed":
    case "limit_reached":
      return "completed"
    case "failed":
      return "failed"
    default:
      return "cancelled"
  }
}

function turnActivities(
  transcript: Transcript,
  turn: TurnView,
  items: TranscriptItem[],
  author: string
): UserStoryAgentActivity[] {
  const activities: UserStoryAgentActivity[] = []
  for (const item of items) {
    const activity = itemActivity(item, transcript, author)
    if (activity) activities.push(activity)
  }
  if (transcript.live && transcript.runningTurn === turn.turn)
    activities.push(...liveActivities(transcript))
  // The turn's last text answers the message once the turn is over.
  if (turn.status !== "running" && turn.status !== "queued") {
    const last = activities.findLastIndex((activity) => activity.kind === "message")
    if (last >= 0) activities[last] = { ...activities[last]!, messageKind: "final" }
  }
  return activities
}

function itemActivity(
  item: TranscriptItem,
  transcript: Transcript,
  author: string
): UserStoryAgentActivity | undefined {
  const base = { id: item.key, createdAt: iso(item.atMs) }
  switch (item.kind) {
    case "text":
      if (!item.text.trim()) return undefined
      return {
        ...base,
        kind: "message",
        title: "Response",
        detail: item.text,
        messageKind: "intermediate",
        status: "completed",
      }
    case "reasoning":
      if (!item.text.trim()) return undefined
      return { ...base, kind: "reasoning", title: "Reasoning", detail: item.text, status: "completed" }
    case "tool_call":
      return toolActivity(item, transcript.toolProgress.get(item.call))
    case "user":
      // A message that joined the running turn (the opening one is the comment).
      if (item.delivery !== "steer") return undefined
      return {
        ...base,
        kind: "notice",
        title: `${author} added`,
        detail: userText(item.blocks),
        status: "completed",
      }
    case "request_failed":
      if (item.retried) return undefined
      return { ...base, kind: "error", title: "The model request failed", detail: item.error.message, status: "failed" }
    case "turn_ended":
      if (item.outcome.status === "failed")
        return { ...base, kind: "error", title: "The agent stopped", detail: item.outcome.error.message, status: "failed" }
      if (item.outcome.status === "limit_reached")
        return { ...base, kind: "notice", title: "Limit reached", detail: `The turn stopped at its ${item.outcome.limit} limit.`, status: "completed" }
      return undefined
    default:
      return undefined
  }
}

function toolActivity(item: ToolCallItem, progress: string | undefined): UserStoryAgentActivity {
  const running =
    item.state === "requested" || item.state === "running" || item.state === "awaiting_approval"
  const failed = !running && item.state !== "completed"
  return {
    id: item.key,
    createdAt: iso(item.atMs),
    kind: item.state === "awaiting_approval" ? "approval" : "tool",
    title: item.state === "awaiting_approval" ? `${item.name} needs your approval` : item.name,
    // The shape the tool views read (describe-tool-call.ts).
    detail: JSON.stringify({
      toolName: item.name,
      input: item.input,
      output: toolOutput(item),
      update: progress,
      durationMs:
        item.startedAtMs && item.finishedAtMs ? item.finishedAtMs - item.startedAtMs : undefined,
    }),
    status: running ? "running" : failed ? "failed" : "completed",
    toolCallId: item.call,
    toolName: item.name,
  }
}

// A client tool answers JSON as text (the web research results); the views
// read it as the value it was. Harness results stay the text the model read.
function toolOutput(item: ToolCallItem) {
  if (!item.result) return item.endedWithoutResult ? "The call ended without a result." : undefined
  const text = item.result
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
  if (item.result.length === 1 && text.trimStart().startsWith("{")) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
  return text
}

function liveActivities(transcript: Transcript): UserStoryAgentActivity[] {
  const live = transcript.live!
  const now = new Date().toISOString()
  return live.blocks.flatMap((block): UserStoryAgentActivity[] => {
    const id = `live:${live.request}:${block.index}`
    if (block.kind === "text")
      return block.text
        ? [{ id, createdAt: now, kind: "message", title: "Response", detail: block.text, messageKind: "intermediate", status: "running" }]
        : []
    if (block.kind === "reasoning")
      return block.text
        ? [{ id, createdAt: now, kind: "reasoning", title: "Reasoning", detail: block.text, status: "running" }]
        : []
    return [
      {
        id,
        createdAt: now,
        kind: "tool",
        title: block.tool ?? "Tool",
        detail: JSON.stringify({ toolName: block.tool, input: partialJson(block.inputJson) }),
        status: "running",
        toolName: block.tool,
      },
    ]
  })
}

function partialJson(json: string) {
  try {
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}

function userText(blocks: readonly { type: string; text?: string }[]) {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n\n")
}

function userFiles(
  blocks: UserItem["blocks"],
  key: string
): UserStoryFileAttachment[] {
  return blocks.flatMap((block, index) =>
    block.type === "text"
      ? []
      : [
          {
            id: `${key}:${index}`,
            name: block.type === "document" ? block.name : `image-${index}`,
            size: block.blob.bytes,
            type: block.blob.media_type,
          },
        ]
  )
}

function agentUsage(turn: UsageTotals, spent: UsageTotals): UserStoryAgentUsage {
  return {
    cacheReadTokens: turn.cacheReadTokens,
    cacheWriteTokens: turn.cacheWriteTokens,
    cost: turn.costMicroUsd / 1_000_000,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    totalCacheReadTokens: spent.cacheReadTokens,
    totalCacheWriteTokens: spent.cacheWriteTokens,
    totalCost: spent.costMicroUsd / 1_000_000,
    totalInputTokens: spent.inputTokens,
    totalOutputTokens: spent.outputTokens,
  }
}

function iso(ms: number) {
  return new Date(ms).toISOString()
}
