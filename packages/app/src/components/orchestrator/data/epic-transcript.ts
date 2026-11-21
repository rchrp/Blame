import {
  parseOrchestratorWake,
  type OrchestratorTool,
  type OrchestratorToolInputs,
  type OrchestratorWake,
} from "@blame/agent-runtime/engine-protocol"
import type {
  ApprovalState,
  ToolCallItem,
  ToolCallState,
  Transcript,
  TranscriptItem,
} from "@blame/engine-client/transcript"

// The epic's conversation as its page shows it (docs/orchestrator.md, "What
// the screen reads"): what the person wrote, the host's wakes as events, the
// orchestrator's words, each acting tool call as a decision, and how each
// turn ended (waiting, a question, the summary). The generic timeline folds
// tool calls into a "worked for" panel; here they are the content.

export type EpicDecisionTool = Exclude<
  OrchestratorTool,
  "epic_board" | "story_report" | "end_turn"
>

export type EpicEntry =
  | { kind: "person"; key: string; text: string; files: number }
  | { kind: "wake"; key: string; wake: OrchestratorWake }
  | { kind: "message"; key: string; text: string; streaming: boolean }
  | {
      kind: "decision"
      key: string
      call: string
      tool: EpicDecisionTool
      input: Partial<OrchestratorToolInputs[EpicDecisionTool]>
      state: ToolCallState
      approval: ApprovalState
      // What the host answered: the call's result once it completed.
      result?: unknown
      // The host's refusal, or why the call ended without doing it.
      refusal?: string
    }
  // A look the orchestrator took (the board, a report, the code, the web).
  | {
      kind: "lookup"
      key: string
      tool: string
      input: unknown
      running: boolean
    }
  | {
      kind: "end"
      key: string
      action: "wait" | "ask" | "finish"
      reason?: string
      question?: string
      options: string[]
      summary?: string
    }
  | { kind: "problem"; key: string; text: string }

const decisionTools = new Set<string>([
  "create_stories",
  "update_story",
  "message_story",
  "approve_story",
  "reject_story",
])

export function epicTranscript(transcript: Transcript): EpicEntry[] {
  const kept = new Set(
    transcript.turns
      .filter(
        (turn) => turn.status !== "rewound" && turn.status !== "withdrawn"
      )
      .map((turn) => turn.turn)
  )
  const entries: EpicEntry[] = []
  for (const item of transcript.items) {
    if ("turn" in item && !kept.has(item.turn)) continue
    const entry = itemEntry(item)
    if (entry) entries.push(entry)
  }
  const live = transcript.live
  if (live && transcript.runningTurn)
    for (const block of live.blocks)
      if (block.kind === "text" && block.text.trim())
        entries.push({
          kind: "message",
          key: `live:${live.request}:${block.index}`,
          text: block.text,
          streaming: true,
        })
  return entries
}

function itemEntry(item: TranscriptItem): EpicEntry | undefined {
  switch (item.kind) {
    case "user": {
      const wake = parseOrchestratorWake(item.blocks)
      if (wake) return { kind: "wake", key: item.key, wake }
      const text = item.blocks
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n\n")
      const files = item.blocks.filter(
        (block) => block.type === "image" || block.type === "document"
      ).length
      if (!text.trim() && !files) return undefined
      return { kind: "person", key: item.key, text, files }
    }
    case "text":
      return item.text.trim()
        ? { kind: "message", key: item.key, text: item.text, streaming: false }
        : undefined
    case "tool_call":
      return toolEntry(item)
    case "request_failed":
      return item.retried
        ? undefined
        : { kind: "problem", key: item.key, text: item.error.message }
    case "turn_ended":
      if (item.outcome.status === "failed")
        return {
          kind: "problem",
          key: item.key,
          text: item.outcome.error.message,
        }
      if (item.outcome.status === "limit_reached")
        return {
          kind: "problem",
          key: item.key,
          text: `The orchestrator stopped at its ${item.outcome.limit} limit.`,
        }
      if (item.outcome.status === "contract_unmet")
        return {
          kind: "problem",
          key: item.key,
          text: "The orchestrator stopped without ending its turn properly.",
        }
      if (item.outcome.status === "interrupted")
        return { kind: "problem", key: item.key, text: "Stopped." }
      return undefined
    default:
      return undefined
  }
}

function toolEntry(item: ToolCallItem): EpicEntry | undefined {
  const input = record(item.input)
  if (item.name === "end_turn") {
    // A refused ending is a decision that did not happen: the model goes on.
    if (item.state === "failed")
      return {
        kind: "problem",
        key: item.key,
        text: `Could not ${String(input.action ?? "end")}: ${resultText(item)}`,
      }
    if (item.state !== "completed") return undefined
    const action = input.action
    if (action !== "wait" && action !== "ask" && action !== "finish")
      return undefined
    return {
      kind: "end",
      key: item.key,
      action,
      reason: text(input.reason),
      question: text(input.question),
      options: Array.isArray(input.options)
        ? input.options.filter(
            (option): option is string => typeof option === "string"
          )
        : [],
      summary: text(input.summary),
    }
  }
  if (decisionTools.has(item.name)) {
    const done = item.state === "completed"
    const ended = !["requested", "running", "awaiting_approval"].includes(
      item.state
    )
    return {
      kind: "decision",
      key: item.key,
      call: item.call,
      tool: item.name as EpicDecisionTool,
      input: input as Partial<OrchestratorToolInputs[EpicDecisionTool]>,
      state: item.state,
      approval: item.approval,
      ...(done ? { result: resultValue(item) } : {}),
      ...(ended && !done && item.state !== "denied"
        ? { refusal: resultText(item) || "The call ended without doing it." }
        : {}),
    }
  }
  return {
    kind: "lookup",
    key: item.key,
    tool: item.name,
    input: item.input,
    running: item.state === "requested" || item.state === "running",
  }
}

/** The question still waiting for the person: the last entry, an ask. */
export function openQuestion(entries: readonly EpicEntry[]) {
  const last = entries.at(-1)
  return last?.kind === "end" && last.action === "ask" ? last : undefined
}

/** Story ids and numbers a decision names (its input, or what it created). */
export function decisionStories(
  entry: Extract<EpicEntry, { kind: "decision" }>
): { ref: string; title?: string }[] {
  const input = record(entry.input)
  if (entry.tool === "create_stories") {
    const created = record(entry.result).created
    if (Array.isArray(created))
      return created.flatMap((item) => {
        const story = record(item)
        const ref = text(story.id) ?? text(story.number)
        return ref ? [{ ref }] : []
      })
    const stories = Array.isArray(input.stories) ? input.stories : []
    return stories.flatMap((item) => {
      const title = text(record(item).title)
      return title ? [{ ref: "", title }] : []
    })
  }
  const storyId = text(input.storyId)
  return storyId ? [{ ref: storyId }] : []
}

function resultValue(item: ToolCallItem): unknown {
  const raw = resultText(item)
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function resultText(item: ToolCallItem) {
  return (item.result ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim()
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}
