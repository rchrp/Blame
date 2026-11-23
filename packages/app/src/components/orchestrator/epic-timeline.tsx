import * as React from "react"
import type { OrchestratorWake } from "@blame/agent-runtime/engine-protocol"
import {
  BellRingIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CheckCheckIcon,
  HourglassIcon,
  ShieldAlertIcon,
} from "lucide-react"

import { userStoryDisplayId } from "@/components/backlog/data/backlog-data"
import { MarkdownMessage } from "@/components/backlog/drawer/markdown-editor"
import { ApprovalDecision } from "@/components/chat/engine/engine-approvals"
import { AgentConversationTimeline } from "@/components/chat/agent-conversation"
import { agentConversationResponseHeader } from "@/components/chat/agent-conversation-header"
import { QueuedMessages } from "@/components/chat/engine/queued-messages"
import {
  ToolCallDetailsProvider,
  type ToolCallDetail,
} from "@/components/chat/tool-calls/tool-call-item"
import type { useEpicConversation } from "./data/use-epic-conversation"
import { useEpicModels } from "./data/use-epic-models"
import type {
  EpicBoardGroup,
  EpicBoardStory,
} from "@/components/orchestrator/data/epic-board"
import type { Epic } from "@/components/orchestrator/data/epic-data"
import { modelIntentLabels } from "@/components/orchestrator/data/epic-model-range"
import {
  decisionStories,
  personSentence,
  type EpicEntry,
} from "@/components/orchestrator/data/epic-transcript"

type Decision = Extract<EpicEntry, { kind: "decision" }>

type TimelineContext = {
  epic: Epic
  stories: ReadonlyMap<string, { story: EpicBoardStory; state: string }>
  onOpenStory: (storyId: string) => void
}

// The same turns and work log as Chat. Host wakes replace the user bubble,
// and completed end_turn calls leave an actionable outcome below the turn.
export function EpicTimeline({
  chat,
  epic,
  groups,
  onOpenStory,
  openQuestionKey,
  onFileLinkClick,
}: Omit<TimelineContext, "stories"> & {
  groups: EpicBoardGroup[]
  chat: ReturnType<typeof useEpicConversation>
  openQuestionKey?: string
  onFileLinkClick: (path: string) => void
}) {
  const models = useEpicModels()
  const stories = React.useMemo(() => {
    const byRef = new Map<string, { story: EpicBoardStory; state: string }>()
    for (const group of groups)
      for (const { story, note } of group.entries) {
        const item = { story, state: note ?? group.title }
        byRef.set(story.id, item)
        byRef.set(userStoryDisplayId(story), item)
      }
    return byRef
  }, [groups])
  const context = { epic, stories, onOpenStory }
  const conversation = chat.conversation
  if (!conversation) return null
  const entries = new Map(chat.entries.map((entry) => [entry.key, entry]))
  const turnContent = new Map<
    string,
    { opening?: React.ReactNode; outcome?: React.ReactNode }
  >()
  const tools = new Map<string, ToolCallDetail>()
  for (const run of conversation.runs) {
    const start = run.commentId && entries.get(run.commentId)
    const opening =
      start && start.kind === "wake" ? (
        <WakeRow context={context} wake={start.wake} />
      ) : undefined
    let outcome: React.ReactNode
    let narrated = false
    for (const activity of run.activities ?? []) {
      if (activity.kind === "message") narrated = true
      const entry = entries.get(activity.id)
      if (entry?.kind === "end") {
        // A reply is the message above: nothing more to show.
        if (openQuestionKey !== entry.key && entry.action !== "reply")
          outcome = <EndRow context={context} end={entry} />
      } else if (entry?.kind === "decision") {
        const attention =
          entry.state === "awaiting_approval" ||
          entry.state === "denied" ||
          Boolean(entry.refusal)
        let inlineContent: React.ReactNode
        if (entry.state === "awaiting_approval") {
          inlineContent = (
            <div className="grid gap-2 text-sm">
              <p className="font-medium">{decisionTitle(entry, epic)}?</p>
              <DecisionContent decision={entry} context={context} />
              <ApprovalDecision call={entry.call} neutral />
            </div>
          )
        } else if (
          entry.tool === "create_stories" &&
          entry.state === "completed"
        ) {
          inlineContent = (
            <CreatedStories
              decision={entry}
              context={context}
              narrated={narrated}
            />
          )
          narrated = false
        }
        tools.set(entry.key, {
          inlineContent,
          family: entry.tool === "create_stories" ? "plan" : "agent",
          verb: decisionTitle(entry, epic),
          failed: Boolean(entry.refusal) || entry.state === "denied",
          needsAttention: attention,
          content: <DecisionContent decision={entry} context={context} />,
        })
      }
    }
    if (opening || outcome) turnContent.set(run.id, { opening, outcome })
  }
  const header = (model?: {
    providerId?: string | null
    modelId?: string | null
  }) =>
    agentConversationResponseHeader({
      providerId:
        model?.providerId ?? epic.settings.orchestratorModel?.providerId,
      modelId: model?.modelId ?? epic.settings.orchestratorModel?.modelId,
      fallbackName: "Orchestrator",
      providers: models.allProviders,
    })
  return (
    <ToolCallDetailsProvider value={tools}>
      <AgentConversationTimeline
        comments={conversation.comments}
        runs={conversation.runs}
        responseHeader={header(conversation.runs.at(-1))}
        responseHeaderForRun={header}
        onFileLinkClick={onFileLinkClick}
        turnContent={turnContent}
        queued={
          <QueuedMessages
            controls={chat.queue}
            queued={conversation.queued.filter(
              (item) => entries.get(item.comment.id)?.kind !== "wake"
            )}
          />
        }
      />
    </ToolCallDetailsProvider>
  )
}

function EventRow({
  children,
  icon,
}: {
  children: React.ReactNode
  icon: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2 px-1 py-1 text-sm text-muted-foreground [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
      {icon}
      <div className="grid min-w-0 gap-1">{children}</div>
    </div>
  )
}

function WakeRow({
  context,
  wake,
}: {
  context: TimelineContext
  wake: OrchestratorWake
}) {
  if (wake.reason === "resumed")
    return (
      <EventRow icon={<BellRingIcon />}>
        {wake.cut === "pause"
          ? "The epic was resumed after its pause: the orchestrator goes on from the board."
          : "Blame was restarted while the orchestrator worked: it goes on from the board."}
      </EventRow>
    )
  if (wake.reason === "idle" && !wake.stories.length)
    return (
      <EventRow icon={<BellRingIcon />}>
        <span>
          Nothing of the epic can move by itself any more: the orchestrator
          decides what comes next.
          {wake.budget?.spent ? " The budget is spent." : null}
        </span>
        <WakeBlocked context={context} wake={wake} />
      </EventRow>
    )
  const count = wake.stories.length
  return (
    <div className="grid min-w-0 gap-2 text-sm text-muted-foreground">
      <details open className="group/reports">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          {count} {count === 1 ? "story update" : "story updates"}
          <ChevronDownIcon className="size-3.5 -rotate-90 group-open/reports:rotate-0" />
        </summary>
        <ul className="mt-2 divide-y rounded-lg border border-border/70">
          {wake.stories.map((story) => (
            <li
              key={`${story.session}:${story.turn}`}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2"
            >
              <span>Update from</span>
              <StoryChip
                context={context}
                storyRef={story.storyId}
                fallback={story.number}
              />
              <span className="ml-auto text-xs">{wakeOutcome(story)}</span>
            </li>
          ))}
        </ul>
      </details>
      <WakeBlocked context={context} wake={wake} />
      {wake.budget?.spent && <span>The budget is spent.</span>}
    </div>
  )
}

// Queued stories only the person can start, each with why.
function WakeBlocked({
  context,
  wake,
}: {
  context: TimelineContext
  wake: OrchestratorWake
}) {
  if (!wake.blocked?.length) return null
  return (
    <>
      <span>Only you can start:</span>
      <ul className="grid gap-0.5">
        {wake.blocked.map((story) => (
          <li key={story.storyId} className="flex flex-wrap gap-x-1.5">
            <StoryChip
              context={context}
              storyRef={story.storyId}
              fallback={story.number}
            />
            <span className="text-muted-foreground">{story.reason}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

function wakeOutcome(story: OrchestratorWake["stories"][number]) {
  if (story.verified) return "verified"
  if (story.failingChecks?.length)
    return `failed its checks (${story.failingChecks.join(", ")})`
  if (story.outcome === "failed")
    return `failed${story.error ? `: ${story.error}` : ""}`
  if (story.outcome === "interrupted") return "was stopped"
  if (story.outcome === "limit_reached") return "hit a limit"
  return "ended without verified work"
}

function CreatedStories({
  decision,
  context,
  narrated,
}: {
  decision: Decision
  context: TimelineContext
  narrated: boolean
}) {
  const created = decisionStories(decision)
  if (!created.length) return null
  return (
    <div className="grid min-w-0 gap-2">
      {!narrated && decision.input.reason && (
        <p className="text-sm leading-relaxed">{decision.input.reason}</p>
      )}
      <ul className="grid w-full max-w-md gap-1.5" aria-label="Created stories">
        {created.map(({ ref, title }) => {
          const item = context.stories.get(ref)
          const content = (
            <>
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate text-sm font-medium">
                  {item?.story.title ?? title ?? ref}
                </span>
                {item && (
                  <span className="truncate text-xs text-muted-foreground">
                    {userStoryDisplayId(item.story)} · {item.state}
                  </span>
                )}
              </span>
              {item && (
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
              )}
            </>
          )
          return (
            <li key={ref || title}>
              {item ? (
                <button
                  type="button"
                  onClick={() => context.onOpenStory(item.story.id)}
                  className="group flex w-full items-center justify-between gap-3 rounded-lg bg-muted/65 px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {content}
                </button>
              ) : (
                <span className="flex rounded-lg bg-muted/65 px-3 py-2.5">
                  {content}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function DecisionContent({
  decision,
  context,
}: {
  decision: Decision
  context: TimelineContext
}) {
  return (
    <div className="grid gap-1.5 py-1 text-sm text-muted-foreground">
      <DecisionStories context={context} decision={decision} />
      {decision.input.reason && <p>{decision.input.reason}</p>}
      <DecisionDetail decision={decision} />
      {decision.refusal && <Refusal text={decision.refusal} />}
      {decision.state === "denied" && (
        <p>You denied it. The orchestrator was told.</p>
      )}
    </div>
  )
}

// The host's first sentence is for the person; what it told the
// orchestrator to do instead stays one click away.
function Refusal({ text }: { text: string }) {
  const sentence = personSentence(text)
  const rest = text.trim().slice(sentence.length).trim()
  return (
    <div className="grid gap-1 border-l-2 border-muted-foreground/40 pl-3 text-foreground">
      <p className="flex items-start gap-1.5">
        <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
        <span className="break-words">Refused: {sentence}</span>
      </p>
      {rest ? (
        <details className="pl-5 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">
            What the orchestrator was told
          </summary>
          <p className="mt-1 break-words whitespace-pre-wrap">{rest}</p>
        </details>
      ) : null}
    </div>
  )
}

function decisionTitle(decision: Decision, epic: Epic) {
  const input = decision.input as Record<string, unknown>
  const done = decision.state === "completed"
  const branch = epic.branch ?? "the epic's branch"
  switch (decision.tool) {
    case "create_stories": {
      const count = Array.isArray(input.stories) ? input.stories.length : 0
      const stories = count === 1 ? "1 story" : `${count} stories`
      return done ? `Created ${stories}` : `Create ${stories}`
    }
    case "update_story":
      return done
        ? `Updated a story${input.queue ? " and queued it" : ""}`
        : `Update a story${input.queue ? " and queue it" : ""}`
    case "message_story":
      return input.kind === "changes"
        ? `${done ? "Asked" : "Ask"} for changes${input.escalate ? " on a smarter model" : ""}`
        : `${done ? "Answered" : "Answer"} the agent`
    case "approve_story": {
      const result = decision.result as { into?: string } | undefined
      return done
        ? `Approved and merged into ${result?.into ?? branch}`
        : `Approve and merge into ${branch}`
    }
    case "reject_story":
      return done ? "Rejected" : "Reject"
  }
}

// What the call does, readable before Allow: the stories it creates, the
// message it sends.
function DecisionDetail({ decision }: { decision: Decision }) {
  const input = decision.input as Record<string, unknown>
  if (decision.tool === "create_stories" && decision.state !== "completed") {
    const stories = Array.isArray(input.stories) ? input.stories : []
    return (
      <ul className="grid gap-1">
        {stories.map((item, index) => {
          const story = item as Record<string, unknown>
          const intent = story.intent as keyof typeof modelIntentLabels
          const after = Array.isArray(story.startsAfter)
            ? story.startsAfter
            : []
          return (
            <li key={index} className="rounded-md bg-muted/60 px-2 py-1">
              <span className="font-medium">{String(story.title ?? "")}</span>
              <span className="text-muted-foreground">
                {modelIntentLabels[intent]
                  ? ` · ${modelIntentLabels[intent]}`
                  : ""}
                {after.length ? ` · after ${after.join(", ")}` : ""}
                {story.hold ? " · held" : ""}
              </span>
            </li>
          )
        })}
      </ul>
    )
  }
  if (decision.tool === "message_story" && typeof input.message === "string")
    return (
      <blockquote className="border-l-2 pl-2 whitespace-pre-wrap text-muted-foreground">
        {input.message}
      </blockquote>
    )
  return null
}

function DecisionStories({
  context,
  decision,
}: {
  context: TimelineContext
  decision: Decision
}) {
  const stories = decisionStories(decision)
  if (!stories.length) return null
  return (
    <span className="flex flex-wrap gap-1.5">
      {stories.map((story, index) =>
        story.ref ? (
          <StoryChip key={story.ref} context={context} storyRef={story.ref} />
        ) : (
          <span
            key={index}
            className="rounded-md bg-muted px-1.5 py-0.5 text-xs"
          >
            {story.title}
          </span>
        )
      )}
    </span>
  )
}

// A story the row names, by its id or its number: opens it in the drawer.
function StoryChip({
  context,
  fallback,
  storyRef,
}: {
  context: TimelineContext
  fallback?: string
  storyRef: string
}) {
  const story = context.stories.get(storyRef)?.story
  if (!story)
    return <span className="text-xs font-medium">{fallback ?? storyRef}</span>
  return (
    <button
      className="inline-flex max-w-full min-w-0 items-baseline gap-1.5 rounded-sm text-left text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      title={`Open ${userStoryDisplayId(story)}`}
      type="button"
      onClick={() => context.onOpenStory(story.id)}
    >
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {userStoryDisplayId(story)}
      </span>
      <span className="truncate text-foreground underline decoration-border underline-offset-2">
        {story.title}
      </span>
    </button>
  )
}

function EndRow({
  context,
  end,
}: {
  context: TimelineContext
  end: Extract<EpicEntry, { kind: "end" }>
}) {
  if (end.action === "wait")
    return (
      <EventRow icon={<HourglassIcon />}>
        <span className="text-foreground">Waiting for the stories</span>
        {end.reason ? <span>{end.reason}</span> : null}
      </EventRow>
    )
  if (end.action === "ask")
    return <MarkdownMessage appearance="plain" markdown={end.question ?? ""} />
  const { epic } = context
  return (
    <div className="grid gap-2 text-sm">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <CheckCheckIcon className="size-4" /> Ready for your review
      </span>
      <MarkdownMessage appearance="plain" markdown={end.summary ?? ""} />
      <p className="text-muted-foreground">
        Review <code>{epic.branch ?? "the epic branch"}</code>
        {epic.targetBranch && (
          <>
            {" "}
            before merging into <code>{epic.targetBranch}</code>
          </>
        )}
        .
      </p>
    </div>
  )
}
