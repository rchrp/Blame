// What the shared conversation timeline shows, from an engine session's
// transcript (TranscriptReducer of @blame/engine-client), in the runs and
// activities the timeline components take.

import { PLAN_TOOL, turnReply, turnReplyImages, unverifiedChecks } from "@blame/engine-client/transcript"
import type {
  PlanChange,
  ToolCallItem,
  Transcript,
  TranscriptItem,
  TurnView,
  UsageTotals,
  UserItem,
} from "@blame/engine-client/transcript"
import type { ErrorInfo, ErrorKind } from "@blame/engine-client"

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
import { modelLimitOfError, modelLimitText } from "../../../lib/model-limit.ts"

/** A message queued behind the running turn: shown with its controls, not as a turn. */
export type QueuedMessage = {
  /** The engine turn it opens when it runs (what withdraw and promote name). */
  turn: string
  comment: AgentConversationComment
  /** Text only: an edit sends its new text again (files are not re-sent). */
  editable: boolean
}

export type TranscriptConversation = {
  comments: AgentConversationComment[]
  runs: AgentConversationRun[]
  /** Messages waiting for the running turn to end, oldest first. */
  queued: QueuedMessage[]
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
  const queued: QueuedMessage[] = []
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
  // A withdrawn turn never ran (its message was removed, or sent into the
  // running turn, where it shows as a steer).
  const kept = transcript.turns.filter(
    (turn) => turn.status !== "rewound" && turn.status !== "withdrawn"
  )
  for (const turn of kept) {
    if (turn.status !== "queued") continue
    const opening = (itemsByTurn.get(turn.turn) ?? []).find(
      (item): item is UserItem => item.kind === "user" && item.delivery === "turn"
    )
    if (!opening) continue
    queued.push({
      turn: turn.turn,
      comment: {
        author,
        body: userText(opening.blocks),
        createdAt: iso(opening.atMs),
        fileAttachments: userFiles(opening.blocks, opening.key),
        id: opening.key,
      },
      editable: opening.blocks.every((block) => block.type === "text"),
    })
  }
  const ran = kept.filter((turn) => turn.status !== "queued")
  for (const [index, turn] of ran.entries()) {
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
    const reply = turnReply(turn, items)
    const activities = turnActivities(transcript, turn, items, author, reply)
    // The screenshots finish_task attached go above the final reply.
    const images = turnReplyImages(turn, items)
    const final = activities.find((activity) => activity.messageKind === "final")
    if (final && images.length) final.images = images
    const model = items.find(
      (item) => (item.kind === "text" || item.kind === "tool_call") && item.message?.model
    )
    const modelRef =
      model && "message" in model ? model.message?.model : transcript.config?.model
    runs.push({
      activities,
      // Turns that can be undone count as checkpoints for the timeline.
      checkpointRunCount: opening?.kind === "user" && opening.rewind ? ++checkpoints : null,
      commentId: opening?.key ?? null,
      completedAt: turn.endedAtMs ? iso(turn.endedAtMs) : null,
      createdAt: iso(turn.startedAtMs),
      diffStartRef: snapshots.get(turn.turn) ?? null,
      diffEndRef: ran.slice(index + 1).map((next) => snapshots.get(next.turn)).find(Boolean) ?? null,
      finalResponse: reply ?? null,
      id: turn.turn,
      kind: brief ? "initial" : "change-request",
      modelId: modelRef?.model ?? null,
      providerId: modelRef?.provider ?? null,
      // The selector says "none" for what the engine calls "off".
      reasoningEffort:
        transcript.config?.reasoning === "off"
          ? "none"
          : (transcript.config?.reasoning ?? null),
      status: runStatus(turn),
      usage: agentUsage(turn.usage, transcript.usage.spent),
    })
  }
  return { comments, queued, rewindTargets, runs }
}

function runStatus(turn: TurnView): UserStoryAgentRunStatus {
  // Its reply stands, unverified (turnReply): the work ended, it did not stop.
  if (unverifiedChecks(turn)) return "completed"
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
  author: string,
  reply: string | undefined
): UserStoryAgentActivity[] {
  const activities: UserStoryAgentActivity[] = []
  for (const item of items) {
    const activity = itemActivity(item, transcript, author)
    // The turn ends on the failure its request just showed: say it once.
    const previous = activities.at(-1)
    // (A limit's reset is counted from each record's time: same action, same failure.)
    if (
      activity?.kind === "error" &&
      previous?.kind === "error" &&
      (previous.detail === activity.detail ||
        (previous.action === "choose-model" && activity.action === "choose-model"))
    )
      continue
    if (activity) activities.push(activity)
  }
  if (transcript.live && transcript.runningTurn === turn.turn)
    activities.push(...liveActivities(transcript))
  if (reply !== undefined) {
    // The accepted finish's summary is the reply: its card leaves it out.
    for (const activity of activities)
      if (activity.kind === "tool" && activity.toolName === "finish_task" && activity.status === "completed") {
        const detail = JSON.parse(activity.detail) as { input?: { summary?: unknown } }
        const summary = detail.input?.summary
        if (typeof summary === "string" && summary.trim() === reply.trim())
          activity.detail = JSON.stringify({ ...detail, replyShown: true })
      }
    const lastText = activities.findLastIndex((activity) => activity.kind === "message")
    const message = activities[lastText]
    if (message && message.detail.trim() === reply.trim()) {
      message.messageKind = "final"
      message.detail = reply
      if (turn.status === "completed" && lastText !== activities.length - 1) {
        activities.splice(lastText, 1)
        activities.push(message)
      }
    } else {
      activities.push({
        id: `${turn.turn}-final-response`,
        createdAt: iso(turn.endedAtMs ?? turn.startedAtMs),
        kind: "message",
        title: "Response",
        detail: reply,
        messageKind: "final",
        status: "completed",
      })
    }
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
    case "tool_call": {
      // What an update of the plan changed is the line it shows as; one that
      // changed nothing the person can see is not shown.
      const change = item.name === PLAN_TOOL ? transcript.planChanges.get(item.call) : undefined
      if (change?.kind === "same") return undefined
      return toolActivity(item, transcript.toolProgress.get(item.call), change)
    }
    case "user":
      // A message that joined the running turn (the opening one is the
      // comment): the person's own message, where it joined the work.
      if (item.delivery !== "steer") return undefined
      return {
        ...base,
        kind: "user",
        title: author,
        detail: userText(item.blocks),
        status: "completed",
        fileAttachments: userFiles(item.blocks, item.key),
      }
    case "request_failed":
      if (item.retried) return undefined
      return errorActivity(base, item.error, item.atMs)
    case "turn_ended":
      if (item.outcome.status === "failed")
        return errorActivity(base, item.outcome.error, item.atMs)
      if (item.outcome.status === "limit_reached")
        return { ...base, kind: "notice", title: "Limit reached", detail: `The turn stopped at its ${item.outcome.limit} limit.`, status: "completed" }
      // A reply the checks refused stands with its note (turnReply).
      if (item.outcome.status === "contract_unmet" && !unverifiedChecks(item))
        return {
          ...base,
          kind: "error",
          title: "Not finished",
          detail: unfinishedTurnDetail(item.outcome.refused),
          status: "failed",
        }
      return undefined
    default:
      return undefined
  }
}

/** A turn the agent ended without a finish the checks accepted. */
export const unfinishedTurnText =
  "The agent stopped without finishing: its work was not checked with finish_task."

/** Why the finish was refused, when it was because the plan still had steps to do. */
function unfinishedTurnDetail(refused: { kind: string; steps?: string[] } | undefined) {
  if (refused?.kind !== "open_plan" || !refused.steps?.length) return unfinishedTurnText
  const count = refused.steps.length
  return `The agent stopped with ${count === 1 ? "a step" : `${count} steps`} of its plan still open: ${refused.steps.join("; ")}.`
}

/**
 * A failed request or turn. A model whose plan is used up (or whose key has
 * no credit) gets the one message that says when it resets and where to
 * choose another model, with the button to that setting.
 */
function errorActivity(
  base: { id: string; createdAt: string },
  error: ErrorInfo,
  atMs: number
): UserStoryAgentActivity {
  const limit = modelLimitOfError(error, atMs)
  const detail = limit ? modelLimitText(limit, "conversation") : error.message
  return {
    ...base,
    kind: "error",
    title: errorTitle(error.kind),
    detail,
    status: "failed",
    ...(limit ? { action: "choose-model" as const } : {}),
  }
}

/** What went wrong, in a few words; the engine's message says the rest. */
function errorTitle(kind: ErrorKind) {
  switch (kind) {
    case "model_unavailable":
      return "Model not available"
    case "authentication":
      return "Sign-in refused"
    case "billing":
      return "No credit left"
    case "usage_limit":
      return "Usage limit reached"
    case "rate_limited":
      return "Rate limited"
    case "overloaded":
      return "Provider unavailable"
    case "context_overflow":
      return "Conversation too long for this model"
    case "transport":
    case "stalled":
      return "Connection lost"
    default:
      return "The agent stopped"
  }
}

function toolActivity(
  item: ToolCallItem,
  progress: string | undefined,
  planChange?: PlanChange
): UserStoryAgentActivity {
  // Images of the result (screenshots) are engine blobs, by their sha256.
  const images = (item.result ?? []).flatMap((block) =>
    block.type === "image" ? [{ caption: item.name, id: block.blob.sha256 }] : []
  )
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
      ...(planChange ? { planChange } : {}),
      durationMs:
        item.startedAtMs && item.finishedAtMs ? item.finishedAtMs - item.startedAtMs : undefined,
    }),
    status: running ? "running" : failed ? "failed" : "completed",
    toolCallId: item.call,
    toolName: item.name,
    ...(images.length ? { images } : {}),
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
  // Text and context (what only the model reads) are not files.
  return blocks.flatMap((block, index) =>
    block.type !== "image" && block.type !== "document"
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
