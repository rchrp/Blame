import * as React from "react"
import type { OrchestratorWake } from "@blame/agent-runtime/engine-protocol"
import {
  BellRingIcon,
  CheckCircle2Icon,
  EyeIcon,
  FlagIcon,
  GitMergeIcon,
  HourglassIcon,
  LoaderCircleIcon,
  MessageSquareReplyIcon,
  PencilIcon,
  PlusIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"

import { userStoryDisplayId } from "@/components/backlog/data/backlog-data"
import { MarkdownMessage } from "@/components/backlog/drawer/markdown-editor"
import { ApprovalDecision } from "@/components/chat/engine/engine-approvals"
import type { EpicBoardStory } from "@/components/orchestrator/data/epic-board"
import type { Epic } from "@/components/orchestrator/data/epic-data"
import { modelIntentLabels } from "@/components/orchestrator/data/epic-model-range"
import {
  decisionStories,
  type EpicEntry,
} from "@/components/orchestrator/data/epic-transcript"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Decision = Extract<EpicEntry, { kind: "decision" }>
type Lookup = Extract<EpicEntry, { kind: "lookup" }>

type TimelineContext = {
  epic: Epic
  stories: readonly EpicBoardStory[]
  onOpenStory: (storyId: string) => void
}

// The epic's conversation: the person's messages, the host's wakes as
// events, the orchestrator's words and each decision it took, with Allow and
// Deny on those that wait for the person.
export function EpicTimeline({
  entries,
  epic,
  onAnswer,
  onOpenStory,
  openQuestionKey,
  stories,
}: TimelineContext & {
  entries: EpicEntry[]
  // The question still open, whose options answer it.
  openQuestionKey?: string
  onAnswer: (answer: string) => void
}) {
  const context = { epic, onOpenStory, stories }
  return (
    <ol className="grid gap-3">
      {groupLookups(entries).map((entry) => (
        <li key={Array.isArray(entry) ? entry[0]!.key : entry.key}>
          {Array.isArray(entry) ? (
            <LookupRow lookups={entry} context={context} />
          ) : (
            <EntryRow
              context={context}
              entry={entry}
              open={entry.key === openQuestionKey}
              onAnswer={onAnswer}
            />
          )}
        </li>
      ))}
    </ol>
  )
}

function EntryRow({
  context,
  entry,
  open,
  onAnswer,
}: {
  context: TimelineContext
  entry: Exclude<EpicEntry, Lookup>
  open: boolean
  onAnswer: (answer: string) => void
}) {
  switch (entry.kind) {
    case "person":
      return (
        <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-primary/10 px-3.5 py-2 text-sm break-words whitespace-pre-wrap">
          {entry.text}
          {entry.files ? (
            <span className="mt-1 block text-xs text-muted-foreground">
              {entry.files === 1 ? "1 file" : `${entry.files} files`} attached
            </span>
          ) : null}
        </div>
      )
    case "wake":
      return <WakeRow wake={entry.wake} context={context} />
    case "message":
      return (
        <MarkdownMessage
          animateAppend={entry.streaming}
          appearance="plain"
          markdown={entry.text}
        />
      )
    case "decision":
      return <DecisionRow decision={entry} context={context} />
    case "end":
      return (
        <EndRow end={entry} context={context} open={open} onAnswer={onAnswer} />
      )
    case "problem":
      return (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{entry.text}</span>
        </p>
      )
  }
}

function EventRow({
  children,
  icon,
}: {
  children: React.ReactNode
  icon: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
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
        Blame stopped while the orchestrator worked. It goes on from the board.
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
    <EventRow icon={<BellRingIcon />}>
      <span>
        {count === 1 ? "1 story" : `${count} stories`} finished a turn:
      </span>
      <ul className="grid gap-0.5">
        {wake.stories.map((story) => (
          <li
            key={`${story.session}:${story.turn}`}
            className="flex flex-wrap gap-x-1.5"
          >
            <StoryChip
              context={context}
              storyRef={story.storyId}
              fallback={story.number}
            />
            <span className={wakeOutcomeClass(story)}>
              {wakeOutcome(story)}
            </span>
          </li>
        ))}
      </ul>
      <WakeBlocked context={context} wake={wake} />
      {wake.budget?.spent ? <span>The budget is spent.</span> : null}
    </EventRow>
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
            <span className="text-amber-700 dark:text-amber-300">
              {story.reason}
            </span>
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

function wakeOutcomeClass(story: OrchestratorWake["stories"][number]) {
  return story.verified
    ? "text-emerald-700 dark:text-emerald-300"
    : "text-amber-700 dark:text-amber-300"
}

function DecisionRow({
  context,
  decision,
}: {
  context: TimelineContext
  decision: Decision
}) {
  const waiting = decision.state === "awaiting_approval"
  const running = decision.state === "requested" || decision.state === "running"
  const refused = Boolean(decision.refusal)
  const denied = decision.state === "denied"
  return (
    <div
      className={cn(
        "grid gap-1.5 rounded-lg border bg-background px-3 py-2.5 text-sm shadow-xs",
        waiting && "border-amber-500/50 bg-amber-500/5",
        (refused || denied) && "border-dashed"
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-muted-foreground [&>svg]:size-4">
          {running ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : (
            decisionIcon(decision)
          )}
        </span>
        <div className="grid min-w-0 flex-1 gap-1">
          <span
            className={cn(
              "font-medium",
              (refused || denied) && "text-muted-foreground"
            )}
          >
            {decisionTitle(decision, context.epic)}
          </span>
          <DecisionStories context={context} decision={decision} />
          {decision.input.reason ? (
            <span className="text-muted-foreground">
              {decision.input.reason}
            </span>
          ) : null}
          <DecisionDetail decision={decision} />
        </div>
      </div>
      {refused ? (
        <p className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-destructive">
          <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">Refused: {decision.refusal}</span>
        </p>
      ) : null}
      {denied ? (
        <p className="text-muted-foreground">
          You denied it; the orchestrator was told.
        </p>
      ) : null}
      {waiting ? (
        <div className="grid gap-1 border-t pt-2">
          <span className="text-xs text-muted-foreground">
            Waiting for you: nothing happens until you allow it.
          </span>
          <ApprovalDecision call={decision.call} />
        </div>
      ) : null}
    </div>
  )
}

function decisionIcon(decision: Decision) {
  switch (decision.tool) {
    case "create_stories":
      return <PlusIcon />
    case "update_story":
      return <PencilIcon />
    case "message_story":
      return <MessageSquareReplyIcon />
    case "approve_story":
      return <GitMergeIcon />
    case "reject_story":
      return <XIcon />
  }
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
  const story = context.stories.find(
    (item) => item.id === storyRef || userStoryDisplayId(item) === storyRef
  )
  if (!story)
    return <span className="text-xs font-medium">{fallback ?? storyRef}</span>
  return (
    <button
      className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-left text-xs outline-none hover:bg-muted/70 hover:text-blue-600 focus-visible:ring-2 focus-visible:ring-ring/50 dark:hover:text-blue-300"
      title={`Open ${userStoryDisplayId(story)}`}
      type="button"
      onClick={() => context.onOpenStory(story.id)}
    >
      <span className="shrink-0 font-medium tabular-nums">
        {userStoryDisplayId(story)}
      </span>
      <span className="truncate">{story.title}</span>
    </button>
  )
}

function EndRow({
  context,
  end,
  open,
  onAnswer,
}: {
  context: TimelineContext
  end: Extract<EpicEntry, { kind: "end" }>
  open: boolean
  onAnswer: (answer: string) => void
}) {
  if (end.action === "wait")
    return (
      <EventRow icon={<HourglassIcon />}>
        <span className="text-foreground">Waiting for the stories</span>
        {end.reason ? <span>{end.reason}</span> : null}
      </EventRow>
    )
  if (end.action === "ask")
    return (
      <div className="grid gap-2 rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
        <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
          {open ? "The orchestrator asks you" : "The orchestrator asked"}
        </span>
        <MarkdownMessage appearance="plain" markdown={end.question ?? ""} />
        {end.options.length ? (
          <div className="flex flex-wrap gap-2">
            {end.options.map((option) => (
              <Button
                key={option}
                disabled={!open}
                size="sm"
                type="button"
                variant="outline"
                onClick={() => onAnswer(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        ) : null}
        {open ? (
          <span className="text-xs text-muted-foreground">
            Pick an answer, or write your own below.
          </span>
        ) : null}
      </div>
    )
  const { epic } = context
  return (
    <div className="grid gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
      <span className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
        <FlagIcon className="size-4" />
        The orchestrator&rsquo;s part is done
      </span>
      <MarkdownMessage appearance="plain" markdown={end.summary ?? ""} />
      <p className="flex items-start gap-1.5 border-t pt-2 text-muted-foreground">
        <EyeIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          Left to you: review what landed on{" "}
          <span className="font-mono text-xs">
            {epic.branch ?? "the epic's branch"}
          </span>
          {epic.targetBranch ? (
            <>
              . Nothing reached{" "}
              <span className="font-mono text-xs">{epic.targetBranch}</span>:
              merge the epic&rsquo;s branch into it yourself once you are
              satisfied.
            </>
          ) : (
            "."
          )}
        </span>
      </p>
    </div>
  )
}

function LookupRow({
  context,
  lookups,
}: {
  context: TimelineContext
  lookups: Lookup[]
}) {
  const running = lookups.some((lookup) => lookup.running)
  const labels = [
    ...new Set(lookups.map((lookup) => lookupLabel(lookup, context))),
  ]
  return (
    <p className="flex items-start gap-2 text-xs text-muted-foreground">
      {running ? (
        <LoaderCircleIcon className="mt-px size-3.5 shrink-0 animate-spin" />
      ) : (
        <CheckCircle2Icon className="mt-px size-3.5 shrink-0" />
      )}
      <span>Looked at {labels.join(", ")}</span>
    </p>
  )
}

function lookupLabel(lookup: Lookup, context: TimelineContext) {
  const input = (lookup.input ?? {}) as Record<string, unknown>
  switch (lookup.tool) {
    case "epic_board":
      return "the board"
    case "story_report": {
      const ref = String(input.storyId ?? "")
      const story = context.stories.find(
        (item) => item.id === ref || userStoryDisplayId(item) === ref
      )
      return `${story ? userStoryDisplayId(story) : ref}'s report`
    }
    case "search_code":
    case "read_code":
      return "the code"
    default:
      return lookup.tool.replace(/_/g, " ")
  }
}

// Looks in a row read as one line.
function groupLookups(entries: EpicEntry[]) {
  const grouped: (Exclude<EpicEntry, Lookup> | Lookup[])[] = []
  for (const entry of entries) {
    const last = grouped.at(-1)
    if (entry.kind !== "lookup") grouped.push(entry)
    else if (Array.isArray(last)) last.push(entry)
    else grouped.push([entry])
  }
  return grouped
}
