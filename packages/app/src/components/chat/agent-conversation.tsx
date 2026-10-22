import {
  AlertCircleIcon,
  CheckIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ClockIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  RotateCcwIcon,
  SquareIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Trash2Icon,
} from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import { agentErrorText } from "@/components/backlog/data/agent-flow"
import {
  agentStreamStore,
  type AgentStreamIdentity,
} from "@/components/backlog/data/agent-stream-store"
import type {
  UserStoryAgentActivity,
  UserStoryAgentRunKind,
  UserStoryAgentRunStatus,
  UserStoryAgentUsage,
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import type { VcsFileDiff } from "@/components/backlog/development/development-workspace"
import { readableReasoning } from "@/components/chat/reasoning-text"
import {
  AgentTurnTab,
  turnTabNotchClass,
} from "@/components/chat/agent-turn-tab"
import type { SpeechTarget } from "@/components/backlog/drawer/speech-session-store"
import {
  MarkdownEditor,
  type PendingFileAttachment,
} from "@/components/backlog/drawer/markdown-editor"
import { pendingFileAttachments } from "@/components/backlog/drawer/user-story-attachment-files"
import type { PendingCodeSelectionAttachment } from "@/components/backlog/shared/comment-attachment-events"
import type { AgentConversationResponseHeader } from "@/components/chat/agent-conversation-header"
import { checkpointRunTargets } from "@/components/chat/agent-run-checkpoints"
import type { AgentTurnMetrics } from "@/components/chat/agent-turn-metrics"
import { getVariantLabel } from "@/components/model/model-selection"
import { ProviderMark } from "@/components/model/model-selector"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { CurrentUserAvatar } from "@/components/shared/user-avatar"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { usePlatform } from "@/context/platform"
import { useAnimatedBorderEffect } from "@/hooks/use-animated-border-effect"
import { publicAssetUrl } from "@/lib/public-asset-url"
import { cn } from "@/lib/utils"
import {
  isSpecialistResponseActivityId,
  isSpecialistThreadActivityId,
  specialistResponseActivityId,
  specialistThreadActivityIds,
} from "@/components/backlog/data/specialist-thread"
import { SpecialistThreadDialog } from "./specialist-thread-dialog"
import { record, specialistTool, textOf } from "./tool-calls/tool-call-values"
import { ToolCallItem } from "./tool-calls/tool-call-item"
import {
  AgentScreenshotOwnerProvider,
  ScreenshotGroupProvider,
} from "./screenshots/agent-screenshot-context"
import type { ScreenshotOwner } from "@/lib/agent-screenshot-sync"

// Where a conversation's screenshots are fetched from, and cached under.
export function screenshotOwnerFor(
  kind: ScreenshotOwner["kind"],
  id: string | undefined
): ScreenshotOwner | undefined {
  if (!id) return undefined
  return {
    id,
    kind,
    scope: kind === "userStory" ? `story:${id}` : `chat:${id}`,
  }
}
import { TurnSummary } from "./turn-summary"

type SpecialistAgentAppearance = {
  avatar: string
  color: string
  glowColor: string
}

const specialistAgentAppearances: Record<string, SpecialistAgentAppearance> = {
  "Codebase Analyst": {
    avatar: publicAssetUrl("agents/codebase-analyst.png"),
    color: "oklch(0.78 0.16 195)",
    glowColor: "oklch(0.72 0.19 195 / 28%)",
  },
  "Frontend Design Specialist": {
    avatar: publicAssetUrl("agents/frontend-design-specialist.png"),
    color: "oklch(0.75 0.23 350)",
    glowColor: "oklch(0.7 0.24 350 / 28%)",
  },
  "Risk & Review Analyst": {
    avatar: publicAssetUrl("agents/risk-review-analyst.png"),
    color: "oklch(0.78 0.19 55)",
    glowColor: "oklch(0.72 0.2 55 / 28%)",
  },
  "Story Analyst": {
    avatar: publicAssetUrl("agents/story-analyst.png"),
    color: "oklch(0.72 0.22 300)",
    glowColor: "oklch(0.67 0.23 300 / 28%)",
  },
  "Test & Verification Analyst": {
    avatar: publicAssetUrl("agents/test-verification-analyst.png"),
    color: "oklch(0.76 0.2 145)",
    glowColor: "oklch(0.7 0.2 145 / 28%)",
  },
}

export type AgentConversationComment = {
  author: string
  body: string
  codeSelectionAttachments?: UserStoryCodeSelectionAttachment[] | null
  createdAt: string
  fileAttachments?: UserStoryFileAttachment[] | null
  id: string
  updatedAt?: string | null
}

export type AgentConversationRun = {
  activities?: UserStoryAgentActivity[] | null
  checkpointRunCount?: number | null
  clineSessionId?: string | null
  commentId?: string | null
  completedAt?: string | null
  diffEndRef?: string | null
  createdAt: string
  finalResponse?: string | null
  id: string
  kind: UserStoryAgentRunKind
  lastSequenceNumber?: number | null
  messageId?: string | null
  // The model that answered this turn, when it was recorded.
  modelId?: string | null
  providerId?: string | null
  reasoningEffort?: string | null
  sessionSummary?: string | null
  status: UserStoryAgentRunStatus
  updatedAt?: string | null
  usage?: UserStoryAgentUsage | null
}

export type AgentConversationUserMessageUndo = {
  checkpointRunCount: number
  comment: AgentConversationComment
  run: AgentConversationRun
}

type AgentConversationVisibleMessage =
  | { type: "activity"; activityId: string; runId: string }
  | { type: "comment"; runId: string }

export function AgentConversationTimeline({
  comments,
  unsentComments = [],
  loadChangedFileDiffs,
  onChangedFileClick,
  onUserMessageUndo,
  onFileLinkClick,
  onLoadActivityDetail,
  responseHeader,
  responseHeaderForRun,
  queued,
  runs,
  screenshotOwner,
}: {
  comments: AgentConversationComment[]
  unsentComments?: AgentConversationComment[]
  loadChangedFileDiffs?: (
    sessionId: string,
    checkpointRunCount: number,
    diffEndRef: string
  ) => Promise<VcsFileDiff[]>
  onChangedFileClick?: (path: string, diffs: VcsFileDiff[]) => void
  onUserMessageUndo?: (
    target: AgentConversationUserMessageUndo
  ) => Promise<void> | void
  onFileLinkClick?: (path: string) => void
  onLoadActivityDetail?: (
    run: AgentConversationRun,
    activity: UserStoryAgentActivity
  ) => Promise<string>
  responseHeader: AgentConversationResponseHeader
  // The header of one turn, when turns can use different models.
  responseHeaderForRun?: (
    run: AgentConversationRun
  ) => AgentConversationResponseHeader | undefined
  // Messages waiting for the agent, shown after the conversation.
  queued?: React.ReactNode
  runs: AgentConversationRun[]
  // The story or chat these turns belong to, to fetch synced screenshots.
  screenshotOwner?: ScreenshotOwner
  topOffset?: "default" | "message-actions"
}) {
  const commentsById = React.useMemo(
    () => new Map(comments.map((comment) => [comment.id, comment])),
    [comments]
  )
  const loadActivityDetail = React.useCallback(
    (run: AgentConversationRun, activity: UserStoryAgentActivity) =>
      onLoadActivityDetail?.(run, activity) ?? Promise.resolve(activity.detail),
    [onLoadActivityDetail]
  )
  const lastVisibleMessage = React.useMemo(
    () => lastAgentConversationVisibleMessage(runs, commentsById),
    [commentsById, runs]
  )
  const highlightedFinalResponseRunId = React.useMemo(
    () => lastFinalResponseRunId(runs),
    [runs]
  )
  const checkpointTargets = React.useMemo(
    () => checkpointRunTargets(runs),
    [runs]
  )

  if (runs.length === 0 && unsentComments.length === 0 && !queued) return null

  return (
    <AgentScreenshotOwnerProvider owner={screenshotOwner}>
      <div
        className="grid gap-10"
        aria-busy={runs.some((run) => run.status === "running")}
      >
        {runs.map((run, index) => (
          <AgentConversationTurn
            key={run.id}
            checkpointRunCount={checkpointTargets[index]?.checkpointRunCount}
            loadChangedFileDiffs={loadChangedFileDiffs}
            comment={runComment(run, commentsById)}
            highlightFinalResponse={run.id === highlightedFinalResponseRunId}
            lastVisibleMessage={lastVisibleMessage}
            onFileLinkClick={onFileLinkClick}
            onChangedFileClick={onChangedFileClick}
            onLoadActivityDetail={(activity) =>
              loadActivityDetail(run, activity)
            }
            onUserMessageUndo={onUserMessageUndo}
            modelSwitch={modelSwitched(runs[index - 1], run)}
            responseHeader={responseHeaderForRun?.(run) ?? responseHeader}
            run={run}
          />
        ))}
        {unsentComments.map((comment) => (
          <RunCommentItem
            key={comment.id}
            alwaysVisible
            comment={comment}
            onFileLinkClick={onFileLinkClick}
          />
        ))}
        {queued}
      </div>
    </AgentScreenshotOwnerProvider>
  )
}

function AgentConversationTurn({
  checkpointRunCount,
  comment,
  highlightFinalResponse,
  lastVisibleMessage,
  onFileLinkClick,
  onChangedFileClick,
  onLoadActivityDetail,
  onUserMessageUndo,
  loadChangedFileDiffs,
  modelSwitch,
  responseHeader,
  run,
}: {
  checkpointRunCount?: number
  comment?: AgentConversationComment
  highlightFinalResponse: boolean
  lastVisibleMessage?: AgentConversationVisibleMessage
  onFileLinkClick?: (path: string) => void
  loadChangedFileDiffs?: (
    sessionId: string,
    checkpointRunCount: number,
    diffEndRef: string
  ) => Promise<VcsFileDiff[]>
  onChangedFileClick?: (path: string, diffs: VcsFileDiff[]) => void
  onLoadActivityDetail: (activity: UserStoryAgentActivity) => Promise<string>
  onUserMessageUndo?: (
    target: AgentConversationUserMessageUndo
  ) => Promise<void> | void
  // This turn runs on another model or reasoning than the one before.
  modelSwitch?: boolean
  responseHeader: AgentConversationResponseHeader
  run: AgentConversationRun
}) {
  const activities = agentTimelineActivities(run)
  const sessionId = run.clineSessionId

  function openChangedFile(path: string) {
    if (
      !onChangedFileClick ||
      !loadChangedFileDiffs ||
      !checkpointRunCount ||
      !sessionId ||
      !run.diffEndRef
    ) {
      onFileLinkClick?.(path)
      return
    }
    void loadChangedFileDiffs(sessionId, checkpointRunCount, run.diffEndRef)
      .then((diffs) => onChangedFileClick(path, diffs))
      .catch((error) => toast.error(errorMessage(error)))
  }

  return (
    <section className="grid gap-5" aria-label="Conversation turn">
      <RunCommentItem
        alwaysVisible={
          lastVisibleMessage?.type === "comment" &&
          lastVisibleMessage.runId === run.id
        }
        comment={comment}
        run={run}
        onFileLinkClick={onFileLinkClick}
        onUndo={
          comment && onUserMessageUndo && checkpointRunCount
            ? () => onUserMessageUndo({ checkpointRunCount, comment, run })
            : undefined
        }
      />
      {modelSwitch ? (
        <ModelSwitchNote responseHeader={responseHeader} run={run} />
      ) : null}
      <ScreenshotGroupProvider activities={activities}>
        <div className="grid min-w-0 gap-5">
          <AgentWorkDetails
            activities={activities}
            alwaysVisible={
              lastVisibleMessage?.type === "activity" &&
              lastVisibleMessage.runId === run.id
            }
            highlightFinalResponse={highlightFinalResponse}
            onFileLinkClick={onFileLinkClick}
            onLoadDetail={onLoadActivityDetail}
            responseHeader={responseHeader}
            run={run}
          />
          <TurnSummary
            activities={activities}
            onFileClick={openChangedFile}
            run={run}
          />
        </div>
      </ScreenshotGroupProvider>
    </section>
  )
}

export function AgentConversationComposer({
  agentRunning = false,
  cancelingAgent = false,
  codeSelectionAttachments,
  disabled,
  submitting = false,
  speechSessionKey,
  speechTarget,
  editorKey,
  editorRef,
  fileAttachments,
  mentionDirectory,
  message,
  minHeight = "min-h-24",
  onCodeSelectionAttachmentRemove,
  onFileAttachmentRemove,
  onFileAttachmentsAdd,
  onFileLinkClick,
  onMessageChange,
  onMessageSubmit,
  onMessageSendNow,
  onAgentCancel,
  placeholder,
  submitLabel,
  queueWhileRunning = false,
  title,
  toolbarEnd,
  turnMetrics,
}: {
  // While the agent runs, typing turns Stop into Send (the message waits
  // for the agent, or interrupts it on demand) instead of blocking.
  queueWhileRunning?: boolean
  agentRunning?: boolean
  cancelingAgent?: boolean
  codeSelectionAttachments: PendingCodeSelectionAttachment[]
  disabled?: boolean
  submitting?: boolean
  speechSessionKey?: string
  speechTarget?: SpeechTarget
  editorKey: number
  editorRef: React.RefObject<HTMLDivElement | null>
  fileAttachments: PendingFileAttachment[]
  mentionDirectory?: string
  minHeight?: string
  message: string
  onCodeSelectionAttachmentRemove: (id: string) => void
  onFileAttachmentRemove: (id: string) => void
  onFileAttachmentsAdd: (attachments: UserStoryFileAttachment[]) => void
  onFileLinkClick?: (path: string) => void
  onMessageChange: (message: string) => void
  onMessageSubmit: () => void
  // While the agent runs: ⌘↵ sends the message now instead of queuing it.
  onMessageSendNow?: () => void
  onAgentCancel?: () => void
  placeholder: string
  submitLabel: string
  title?: string
  toolbarEnd?: React.ReactNode
  turnMetrics?: AgentTurnMetrics
}) {
  const hasMessageBody = Boolean(
    message.trim() || codeSelectionAttachments.length || fileAttachments.length
  )

  function submitMessage() {
    if (disabled || submitting || !hasMessageBody) return
    onMessageSubmit()
  }

  const sendWhileRunning = Boolean(
    agentRunning && queueWhileRunning && hasMessageBody
  )
  const stopAction = Boolean(agentRunning && !sendWhileRunning)

  function handlePrimaryAction() {
    if (stopAction) {
      if (!cancelingAgent) onAgentCancel?.()
      return
    }
    submitMessage()
  }

  const primaryActionLabel = stopAction
    ? cancelingAgent
      ? "Canceling agent"
      : "Cancel agent"
    : submitting
      ? "Sending comment"
      : submitLabel

  return (
    <section aria-busy={submitting} className="grid gap-3">
      {title ? (
        <div className="flex items-center gap-4 text-xl font-medium">
          <span className="flex size-11 items-center justify-center rounded-full border bg-muted text-muted-foreground shadow-sm">
            <MessageSquareIcon className="size-5" />
          </span>
          {title}
        </div>
      ) : null}
      <div
        className={cn("relative", turnTabNotchClass)}
        onKeyDownCapture={(event) => {
          if (
            !sendWhileRunning ||
            !onMessageSendNow ||
            event.key !== "Enter" ||
            !(event.metaKey || event.ctrlKey) ||
            event.nativeEvent.isComposing
          )
            return
          event.preventDefault()
          event.stopPropagation()
          if (!event.repeat && !disabled && !submitting) onMessageSendNow()
        }}
      >
        <AgentTurnTab metrics={turnMetrics} />
        <DraftSavedHint message={message} hidden={submitting || disabled} />
        <MarkdownEditor
          speechSessionKey={speechSessionKey}
          speechTarget={speechTarget}
          key={editorKey}
          codeSelectionAttachments={codeSelectionAttachments}
          fileAttachments={fileAttachments}
          mentionDirectory={mentionDirectory}
          ref={editorRef}
          markdown={message}
          onCodeSelectionAttachmentRemove={onCodeSelectionAttachmentRemove}
          onFileAttachmentRemove={onFileAttachmentRemove}
          onFileAttachmentsAdd={onFileAttachmentsAdd}
          onMarkdownChange={onMessageChange}
          onFileLinkClick={onFileLinkClick}
          readOnly={disabled || submitting}
          placeholder={placeholder}
          minHeight={minHeight}
          maxHeight="max-h-80"
          onSubmitShortcut={submitMessage}
          primaryAction={
            <Button
              aria-label={primaryActionLabel}
              className={cn(
                "size-9 rounded-xl border p-0 text-white shadow-md transition-[transform,background-color,box-shadow] duration-200 active:scale-90 disabled:border-muted disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none",
                stopAction
                  ? "border-destructive bg-destructive shadow-destructive/25 hover:bg-destructive/90 hover:text-white"
                  : "border-blue-500 bg-blue-500 shadow-blue-500/25 hover:bg-blue-600 hover:text-white"
              )}
              disabled={
                stopAction
                  ? cancelingAgent || !onAgentCancel
                  : disabled || submitting || !hasMessageBody
              }
              size="icon-sm"
              type="button"
              onClick={handlePrimaryAction}
            >
              <span
                key={
                  submitting ? "submitting" : stopAction ? "running" : "idle"
                }
                className="composer-icon-swap flex items-center justify-center"
              >
                {submitting ? (
                  <LoaderCircleIcon className="size-4 animate-spin" />
                ) : stopAction ? (
                  <SquareIcon className="size-3.5 fill-current" />
                ) : (
                  <ArrowUpIcon className="size-4" />
                )}
              </span>
            </Button>
          }
          toolbarEnd={toolbarEnd}
        />
      </div>
    </section>
  )
}

function RunCommentItem({
  alwaysVisible,
  comment,
  onFileLinkClick,
  onUndo,
  queued,
  run,
}: {
  alwaysVisible: boolean
  comment?: AgentConversationComment
  onFileLinkClick?: (path: string) => void
  onUndo?: (comment: AgentConversationComment) => Promise<void> | void
  queued?: QueuedMessageActions
  run?: AgentConversationRun
}) {
  const entering = useEnterAnimation(comment?.createdAt)
  // A queued message can still be edited before it is sent.
  const [draft, setDraft] = React.useState<string>()
  if (run?.kind === "initial") return null
  if (!comment) return null
  const editing = Boolean(queued?.onEdit) && draft !== undefined
  const saveDraft = () => {
    if (draft?.trim()) queued?.onEdit?.(draft)
    setDraft(undefined)
  }

  return (
    <div
      className={cn(
        "group/message relative w-full min-w-0 pl-[12%]",
        entering && "chat-enter-user"
      )}
    >
      <div className="ml-auto grid w-full max-w-3xl min-w-0 gap-2 overflow-hidden">
        <div
          className={cn(
            // Same inner spacing as agent messages.
            "max-w-full min-w-0 overflow-hidden rounded-3xl [&>div]:max-w-full [&>div]:min-w-0 [&>div]:bg-transparent [&>div]:p-0 [&>div]:shadow-none [&>div]:ring-0",
            queued
              ? "border border-dashed border-foreground/30 bg-muted/35"
              : "bg-muted/80 ring-1 ring-foreground/10",
            queued?.onEdit && !editing && "cursor-text",
            editing && "border-primary/60"
          )}
          onClick={
            queued?.onEdit && !editing
              ? () => setDraft(comment.body)
              : undefined
          }
          onKeyDown={(event) => {
            if (!editing) return
            if (event.key === "Escape") setDraft(undefined)
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              saveDraft()
            }
          }}
        >
          <MarkdownEditor
            codeSelectionAttachments={comment.codeSelectionAttachments ?? []}
            fileAttachments={pendingFileAttachments(
              comment.fileAttachments ?? []
            )}
            markdown={editing ? (draft ?? "") : comment.body}
            onMarkdownChange={editing ? setDraft : undefined}
            readOnly={!editing}
            onFileLinkClick={onFileLinkClick}
            placeholder=""
            minHeight="min-h-0"
          />
        </div>
        {queued && editing ? (
          <div className="flex items-center justify-end gap-1.5">
            <span className="mr-auto pl-3 text-xs text-muted-foreground">
              ⌘↵ to save · Esc to cancel
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => setDraft(undefined)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 rounded-full px-3 text-xs"
              disabled={!draft?.trim()}
              onClick={saveDraft}
            >
              Save
            </Button>
          </div>
        ) : queued ? (
          <QueuedMessageFooter actions={queued} />
        ) : (
          <div className="flex items-center justify-end gap-2">
            {!run ? (
              <span className="text-xs text-muted-foreground">
                Saved · not sent to agent
              </span>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {commentDateLabel(comment.createdAt)}
            </span>
            <MarkdownMessageActions
              alwaysVisible={alwaysVisible}
              markdown={comment.body}
              onUndo={onUndo ? () => onUndo(comment) : undefined}
              undoDisabled={run?.status === "running"}
            />
          </div>
        )}
      </div>
      <div className="absolute top-0 -right-10">
        <UserMessageAvatar author={comment.author} />
      </div>
    </div>
  )
}

type QueuedMessageActions = {
  // Saves a new text; editing is offered only when set.
  onEdit?(body: string): void
  onRemove(): void
  onSendNow(): void
}

// A message waiting for the agent to finish its turn. Dashed so it reads as
// not sent yet; "Send now" interrupts the agent with this message only.
export function QueuedConversationMessage({
  comment,
  onFileLinkClick,
  ...actions
}: QueuedMessageActions & {
  comment: AgentConversationComment
  onFileLinkClick?: (path: string) => void
}) {
  return (
    <RunCommentItem
      alwaysVisible
      comment={comment}
      onFileLinkClick={onFileLinkClick}
      queued={actions}
    />
  )
}

function QueuedMessageFooter({ actions }: { actions: QueuedMessageActions }) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <span className="mr-auto flex items-center gap-1.5 pl-3 text-xs text-muted-foreground">
        <ClockIcon className="size-3.5" />
        {actions.onEdit
          ? "Queued · click to edit"
          : "Queued · sent when the agent finishes"}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Remove queued message"
        title="Remove"
        className="size-7 rounded-full text-muted-foreground hover:text-destructive"
        onClick={actions.onRemove}
      >
        <Trash2Icon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="sm"
        className="h-7 rounded-full px-3 text-xs"
        onClick={actions.onSendNow}
      >
        <ArrowUpIcon className="size-3.5" />
        Send now
      </Button>
    </div>
  )
}

type AgentWorkDetailsProps = {
  activities: UserStoryAgentActivity[]
  alwaysVisible: boolean
  highlightFinalResponse: boolean
  onFileLinkClick?: (path: string) => void
  onLoadDetail: (activity: UserStoryAgentActivity) => Promise<string>
  responseHeader: AgentConversationResponseHeader
  run: AgentConversationRun
}

function AgentWorkDetails(props: AgentWorkDetailsProps) {
  const registry = useAgentActivityRegistry(props.activities, props.run)
  if (!registry.activityIds.length) {
    return props.run.status === "running" ? <AgentThinkingTimelineItem /> : null
  }
  const responseActivityId = terminalResponseActivityId(props, registry)
  // A specialist's steps and answer live on its card, not in the main list.
  const workActivityIds = registry.activityIds.filter(
    (activityId) =>
      activityId !== responseActivityId &&
      !isSpecialistThreadActivityId(activityId) &&
      !isSpecialistResponseActivityId(activityId)
  )
  return (
    <div className="grid gap-2">
      {workActivityIds.length ? (
        <AgentWorkAccordion
          activityIds={workActivityIds}
          registry={registry}
          responseActivityId={responseActivityId}
          {...props}
        />
      ) : null}
      {responseActivityId ? (
        <AgentActivityTimeline
          activityIds={[responseActivityId]}
          registry={registry}
          {...props}
        />
      ) : null}
    </div>
  )
}

function AgentWorkAccordion({
  activityIds,
  registry,
  responseActivityId,
  ...props
}: AgentWorkDetailsProps & {
  activityIds: string[]
  registry: ReturnType<typeof useAgentActivityRegistry>
  responseActivityId?: string
}) {
  const shouldExpand = props.run.status === "running" && !responseActivityId
  const phase = shouldExpand ? "running" : "finished"
  const [selection, setSelection] = React.useState({
    expanded: shouldExpand,
    phase,
  })
  const expanded = selection.phase === phase ? selection.expanded : shouldExpand
  return (
    <Accordion
      collapsible
      onValueChange={(value) =>
        setSelection({ expanded: value === "work", phase })
      }
      type="single"
      value={expanded ? "work" : ""}
    >
      <AccordionItem className="border-b-0!" value="work">
        <AccordionTrigger className="items-center py-0 hover:no-underline">
          <AgentWorkState
            running={props.run.status === "running"}
            stateLabel={agentWorkStateLabel(props.run.status)}
            stepCount={activityIds.length}
            status={props.run.status}
          />
        </AccordionTrigger>
        <AccordionContent className="pt-2 pb-0">
          <AgentActivityTimeline
            {...props}
            activityIds={activityIds}
            alwaysVisible={!responseActivityId && props.alwaysVisible}
            registry={registry}
          />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

function useAgentActivityRegistry(
  activities: UserStoryAgentActivity[],
  run: AgentConversationRun
) {
  const identity = React.useMemo(
    () =>
      run.status === "running" && run.clineSessionId
        ? { runId: run.id, sessionId: run.clineSessionId }
        : undefined,
    [run.clineSessionId, run.id, run.status]
  )
  React.useEffect(() => {
    if (!identity) return
    agentStreamStore.seed(identity, activities, run.lastSequenceNumber ?? 0)
  }, [activities, identity, run.lastSequenceNumber])
  const order = useAgentStreamOrder(identity)
  return {
    activityIds: mergedActivityIds(activities, order.activityIds),
    identity,
    persistedById: new Map(
      activities.map((activity) => [activity.id, activity])
    ),
  }
}

function useAgentStreamOrder(identity: AgentStreamIdentity | undefined) {
  const subscribe = React.useCallback(
    (listener: () => void) =>
      identity
        ? agentStreamStore.subscribeOrder(identity, listener)
        : () => undefined,
    [identity]
  )
  const getSnapshot = React.useCallback(
    () =>
      identity
        ? agentStreamStore.orderSnapshot(identity)
        : emptyAgentStreamOrder,
    [identity]
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function AgentActivityTimeline({
  activityIds,
  activities,
  alwaysVisible,
  registry,
  ...props
}: AgentWorkDetailsProps & {
  activityIds?: string[]
  registry: ReturnType<typeof useAgentActivityRegistry>
}) {
  void activities
  const visibleActivityIds = activityIds ?? registry.activityIds
  return (
    <Accordion type="multiple" className="grid gap-2">
      {visibleActivityIds.map((activityId, index) => (
        <StreamingAgentActivityItem
          {...props}
          activityId={activityId}
          alwaysVisible={
            alwaysVisible && index === visibleActivityIds.length - 1
          }
          fallback={registry.persistedById.get(activityId)}
          identity={registry.identity}
          registry={registry}
          key={`${props.run.id}-${activityId}`}
        />
      ))}
    </Accordion>
  )
}

function terminalResponseActivityId(
  props: AgentWorkDetailsProps,
  registry: ReturnType<typeof useAgentActivityRegistry>
) {
  return registry.activityIds.findLast((activityId) => {
    const activity = registry.persistedById.get(activityId)
    if (activity?.kind === "message") return activity.messageKind === "final"
    return props.run.status !== "running" && activity?.kind === "error"
  })
}

function agentWorkStateLabel(status: AgentConversationRun["status"]) {
  if (status === "running") return "Working"
  return status === "failed" || status === "cancelled"
    ? "Work stopped"
    : "Work completed"
}

function AgentWorkState({
  running,
  stateLabel,
  status,
  stepCount,
}: {
  running: boolean
  stateLabel: string
  status: AgentConversationRun["status"]
  stepCount: number
}) {
  return (
    <span className="flex min-h-10 items-center gap-2.5 py-1 text-sm text-muted-foreground">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          running
            ? "agent-thinking-mark"
            : status === "failed"
              ? "bg-destructive"
              : "bg-emerald-500"
        )}
        aria-hidden="true"
      />
      <span className={running ? "agent-activity-running" : undefined}>
        {stateLabel}
      </span>
      <span>
        · {stepCount} {stepCount === 1 ? "step" : "steps"}
      </span>
    </span>
  )
}

type StreamingAgentActivityItemProps = Omit<
  AgentWorkDetailsProps,
  "activities"
> & {
  activityId: string
  fallback?: UserStoryAgentActivity
  identity?: AgentStreamIdentity
  registry?: ReturnType<typeof useAgentActivityRegistry>
}

function StreamingAgentActivityItem(props: StreamingAgentActivityItemProps) {
  const activity = useStreamedAgentActivity(props)
  return activity ? (
    <AgentStreamActivity activity={activity} {...props} />
  ) : null
}

function useStreamedAgentActivity({
  activityId,
  fallback,
  identity,
}: StreamingAgentActivityItemProps) {
  const subscribe = React.useCallback(
    (listener: () => void) =>
      identity
        ? agentStreamStore.subscribeActivity(identity, activityId, listener)
        : () => undefined,
    [activityId, identity]
  )
  const getSnapshot = React.useCallback(
    () =>
      identity
        ? agentStreamStore.activitySnapshot(identity, activityId)
        : undefined,
    [activityId, identity]
  )
  const live = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return live?.activity ?? fallback
}

function AgentStreamActivity({
  activity,
  ...props
}: StreamingAgentActivityItemProps & {
  activity: UserStoryAgentActivity
}) {
  if (activity.kind === "error") {
    return (
      <AgentStreamError
        activity={activity}
        alwaysVisible={props.alwaysVisible}
      />
    )
  }
  if (activity.kind === "message") {
    return <AgentStreamMessage activity={activity} {...props} />
  }
  if (
    activity.kind === "tool" &&
    specialistTool(activity.toolName) &&
    props.registry
  ) {
    return (
      <SpecialistConsultation
        activity={activity}
        {...props}
        registry={props.registry}
      />
    )
  }
  return <AgentStreamTool activity={activity} {...props} />
}

const fallbackSpecialistAppearance = {
  color: "oklch(0.72 0.16 250)",
  glowColor: "oklch(0.66 0.18 250 / 28%)",
}

// A specialist consultation in the conversation: its answer, cropped with a
// border in the specialist's color, and its full thread on demand.
function SpecialistConsultation({
  activity,
  registry,
  ...props
}: StreamingAgentActivityItemProps & {
  activity: UserStoryAgentActivity
  registry: ReturnType<typeof useAgentActivityRegistry>
}) {
  const [open, setOpen] = React.useState(false)
  const responseId = specialistResponseActivityId(activity.id)
  const response = useStreamedAgentActivity({
    ...props,
    activityId: responseId,
    fallback: registry.persistedById.get(responseId),
    identity: registry.identity,
  })
  const threadIds = activity.toolCallId
    ? specialistThreadActivityIds(registry.activityIds, activity.toolCallId)
    : []
  const name = activity.agentName ?? "Specialist"
  const appearance = specialistAgentAppearanceByName(activity.agentName)
  const effect = appearance ?? fallbackSpecialistAppearance
  const running =
    activity.status === "running" && props.run.status === "running"
  const steps = `${threadIds.length} ${threadIds.length === 1 ? "step" : "steps"}`
  const status = running
    ? `Working · ${steps}`
    : activity.status === "failed" && !response
      ? "Stopped"
      : `Answered · ${steps}`
  const avatarImage = activity.agentAvatar ?? appearance?.avatar
  const avatar = (size: "sm" | "default") => (
    <Avatar size={size} aria-label={name}>
      {avatarImage ? <AvatarImage alt={name} src={avatarImage} /> : null}
      <AvatarFallback>{agentInitials(name)}</AvatarFallback>
    </Avatar>
  )
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {avatar("sm")}
        <span className="truncate font-medium">{name}</span>
        <span
          className={cn(
            "shrink-0 text-muted-foreground",
            running && "agent-activity-running"
          )}
        >
          {status}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 shrink-0 gap-1 rounded-full px-2.5 text-xs text-muted-foreground"
          onClick={() => setOpen(true)}
        >
          {running ? "Follow" : "View thread"}
          <ChevronRightIcon className="size-3.5" />
        </Button>
      </div>
      {response ? (
        <AgentMarkdownTimelineItem
          alwaysVisible={props.alwaysVisible}
          createdAt={response.createdAt}
          effectColor={effect.color}
          effectGlowColor={effect.glowColor}
          highlight={false}
          markdown={response.detail}
          onFileLinkClick={props.onFileLinkClick}
        />
      ) : null}
      <SpecialistThreadDialog
        avatar={avatar("default")}
        name={name}
        onOpenChange={setOpen}
        open={open}
        request={specialistRequest(activity.detail)}
        status={status}
      >
        {threadIds.length ? (
          <AgentActivityTimeline
            {...props}
            activities={[]}
            activityIds={threadIds}
            alwaysVisible={false}
            registry={registry}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {running
              ? "Waiting for the specialist's first step."
              : "The steps of this consultation weren't recorded."}
          </p>
        )}
        {response ? (
          <AgentStreamMessage activity={response} {...props} />
        ) : null}
      </SpecialistThreadDialog>
    </div>
  )
}

// What the lead agent asked the specialist (its consult call input).
function specialistRequest(detail: string) {
  try {
    const input = record(record(JSON.parse(detail)).input)
    const task = textOf(input.task)?.text
    const context = textOf(input.context)?.text
    return [task, context].filter(Boolean).join("\n\n") || undefined
  } catch {
    return undefined
  }
}

function AgentStreamMessage({
  activity,
  alwaysVisible,
  highlightFinalResponse,
  onFileLinkClick,
  responseHeader,
  run,
}: StreamingAgentActivityItemProps & { activity: UserStoryAgentActivity }) {
  return (
    <AgentMarkdownTimelineItem
      alwaysVisible={alwaysVisible}
      avatar={
        <AgentResponseAvatar
          activity={activity}
          responseHeader={responseHeader}
        />
      }
      createdAt={activity.createdAt}
      highlight={highlightFinalResponse && activity.messageKind === "final"}
      markdown={activity.detail}
      onFileLinkClick={onFileLinkClick}
      showFeedback={activity.messageKind === "final"}
      streaming={run.status === "running" && activity.status === "running"}
    />
  )
}

function AgentStreamTool({
  activity,
  alwaysVisible,
  onFileLinkClick,
  onLoadDetail,
  run,
}: StreamingAgentActivityItemProps & { activity: UserStoryAgentActivity }) {
  return (
    <AgentActivityLeafItem
      activity={activity}
      alwaysVisible={alwaysVisible}
      onFileLinkClick={onFileLinkClick}
      onLoadDetail={onLoadDetail}
      runActive={run.status === "running"}
      runningToolActivityId={
        activity.kind === "tool" && activity.status === "running"
          ? activity.id
          : undefined
      }
      value={`${run.id}-${activity.id}`}
    />
  )
}

function AgentStreamError({
  activity,
  alwaysVisible,
}: {
  activity: UserStoryAgentActivity
  alwaysVisible: boolean
}) {
  return (
    <AgentErrorTimelineItem
      actionUrl={activity.actionUrl}
      alwaysVisible={alwaysVisible}
      createdAt={activity.createdAt}
      detail={activity.detail}
      errorCode={activity.errorCode}
      resetAt={activity.resetAt}
    />
  )
}

function AgentThinkingTimelineItem() {
  return (
    <div
      className="chat-enter-agent flex min-w-0 items-center gap-3 px-2 py-2 text-sm text-muted-foreground"
      role="status"
    >
      <span className="agent-thinking-mark" aria-hidden="true" />
      <span className="agent-thinking-text">Thinking</span>
    </div>
  )
}

function AgentActivityLeafItem({
  alwaysVisible,
  activity,
  onFileLinkClick,
  onLoadDetail,
  runActive,
  runningToolActivityId,
  value,
}: {
  alwaysVisible: boolean
  activity: UserStoryAgentActivity
  onFileLinkClick?: (path: string) => void
  onLoadDetail: (activity: UserStoryAgentActivity) => Promise<string>
  runActive: boolean
  runningToolActivityId?: string
  value: string
}) {
  if (activity.kind === "reasoning") {
    return (
      <AgentReasoning
        activity={activity}
        onLoadDetail={onLoadDetail}
        onFileLinkClick={onFileLinkClick}
        runActive={runActive}
      />
    )
  }
  if (activity.kind === "message") {
    const specialistAppearance = specialistAgentAppearance(activity)
    return (
      <AgentMarkdownTimelineItem
        alwaysVisible={alwaysVisible}
        createdAt={activity.createdAt}
        effectColor={specialistAppearance?.color}
        effectGlowColor={specialistAppearance?.glowColor}
        highlight={false}
        markdown={activity.detail}
        onFileLinkClick={onFileLinkClick}
        showFeedback={activity.messageKind === "final"}
        streaming={runActive && activity.status === "running"}
      />
    )
  }

  return (
    <AgentActivityDetailLeafItem
      activity={activity}
      onFileLinkClick={onFileLinkClick}
      onLoadDetail={onLoadDetail}
      runActive={runActive}
      runningToolActivityId={runningToolActivityId}
      value={value}
    />
  )
}

function AgentReasoning({
  activity,
  onLoadDetail,
  onFileLinkClick,
  runActive,
}: {
  activity: UserStoryAgentActivity
  onLoadDetail: (activity: UserStoryAgentActivity) => Promise<string>
  onFileLinkClick?: (path: string) => void
  runActive: boolean
}) {
  const [detail, setDetail] = React.useState<string>()
  React.useEffect(() => {
    if (!activity.detailTruncated || activity.status === "running") return
    let cancelled = false
    void onLoadDetail(activity)
      .then((text) => {
        if (!cancelled) setDetail(text)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activity, onLoadDetail])
  return (
    <MarkdownEditor
      appearance="subtle"
      animateAppend={runActive && activity.status === "running"}
      markdown={readableReasoning(detail ?? activity.detail)}
      minHeight="min-h-0"
      placeholder=""
      readOnly
      onFileLinkClick={onFileLinkClick}
    />
  )
}

function AgentActivityDetailLeafItem({
  activity,
  onFileLinkClick,
  onLoadDetail,
  runActive,
  runningToolActivityId,
  value,
}: {
  activity: UserStoryAgentActivity
  onFileLinkClick?: (path: string) => void
  onLoadDetail: (activity: UserStoryAgentActivity) => Promise<string>
  runActive: boolean
  runningToolActivityId?: string
  value: string
}) {
  const entering = useEnterAnimation(activity.createdAt)
  const running = activityIsRunning(activity, runActive, runningToolActivityId)
  return (
    <ToolCallItem
      activity={activity}
      avatar={specialistAvatar(activity)}
      entering={entering}
      hasFullDetail={Boolean(activity.detailArtifact)}
      onLoadDetail={() => onLoadDetail(activity)}
      onOpenFile={onFileLinkClick}
      running={running}
      value={value}
    />
  )
}

// Specialist agents show their own avatar instead of a tool icon.
function specialistAvatar(activity: UserStoryAgentActivity) {
  if (activity.kind !== "tool" || !specialistTool(activity.toolName))
    return undefined
  const name = activity.agentName ?? "Agent"
  const avatar =
    activity.agentAvatar ??
    specialistAgentAppearanceByName(activity.agentName)?.avatar
  if (!avatar) return undefined
  return (
    <Avatar size="sm" aria-label={name}>
      <AvatarImage alt={name} src={avatar} />
      <AvatarFallback>{agentInitials(name)}</AvatarFallback>
    </Avatar>
  )
}

function lastAgentConversationVisibleMessage(
  runs: AgentConversationRun[],
  commentsById: Map<string, AgentConversationComment>
): AgentConversationVisibleMessage | undefined {
  let lastMessage: AgentConversationVisibleMessage | undefined
  for (const run of runs) {
    if (run.kind !== "initial" && runComment(run, commentsById)) {
      lastMessage = { runId: run.id, type: "comment" }
    }
    const activities = agentTimelineActivities(run)
    for (const activity of activities) {
      if (activity.kind === "message" || activity.kind === "error") {
        lastMessage = {
          activityId: activity.id,
          runId: run.id,
          type: "activity",
        }
      }
    }
  }
  return lastMessage
}

function lastFinalResponseRunId(runs: AgentConversationRun[]) {
  return [...runs]
    .reverse()
    .find((run) =>
      agentDisplayActivities(run).some(
        (activity) =>
          activity.kind === "message" && activity.messageKind === "final"
      )
    )?.id
}

function activityIsRunning(
  activity: UserStoryAgentActivity,
  runActive: boolean,
  runningToolActivityId: string | undefined
) {
  return (
    runActive &&
    activity.kind === "tool" &&
    activity.id === runningToolActivityId
  )
}

function AgentMarkdownTimelineItem({
  alwaysVisible,
  avatar,
  createdAt,
  effectColor,
  effectGlowColor,
  highlight,
  markdown,
  onFileLinkClick,
  showFeedback,
  streaming,
}: {
  alwaysVisible: boolean
  avatar?: React.ReactNode
  createdAt: string
  effectColor?: string
  effectGlowColor?: string
  highlight: boolean
  markdown: string
  onFileLinkClick?: (path: string) => void
  showFeedback?: boolean
  streaming?: boolean
}) {
  const responseRef = useAnimatedBorderEffect(
    highlight ? "agent-response" : undefined,
    effectColor
  )
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [contentOverflows, setContentOverflows] = React.useState(false)
  const [contentHeight, setContentHeight] = React.useState(320)
  const collapsible = Boolean(effectColor)
  const entering = useEnterAnimation(createdAt)
  const effectStyle =
    effectColor && effectGlowColor
      ? ({
          "--agent-response-color": effectColor,
          "--agent-response-glow-color": effectGlowColor,
        } as React.CSSProperties)
      : undefined

  React.useEffect(() => {
    const content = contentRef.current
    if (!collapsible || !content) {
      setContentOverflows(false)
      return
    }

    const updateOverflow = () => {
      const nextHeight = content.scrollHeight
      setContentHeight(nextHeight)
      setContentOverflows(nextHeight > 320)
    }
    updateOverflow()
    const observer = new ResizeObserver(updateOverflow)
    observer.observe(content)
    return () => observer.disconnect()
  }, [collapsible, markdown])

  return (
    <div
      className={cn(
        "group/message relative min-w-0",
        entering && "chat-enter-agent"
      )}
      data-agent-response
    >
      {avatar ? <div className="absolute top-0 -left-10">{avatar}</div> : null}
      <div className="grid min-w-0 gap-2">
        <div
          ref={responseRef}
          className={cn(
            "min-w-0 [&>div]:bg-transparent [&>div]:p-0 [&>div]:shadow-none [&>div]:ring-0",
            highlight && "agent-response-effect",
            effectColor && "sub-agent-response-effect",
            collapsible &&
              contentOverflows &&
              !expanded &&
              "sub-agent-response-collapsed"
          )}
          style={effectStyle}
        >
          <div
            ref={contentRef}
            className={cn(
              "relative [&>div]:bg-transparent [&>div]:p-0 [&>div]:shadow-none [&>div]:ring-0",
              effectColor && "sub-agent-response-content",
              collapsible &&
                "overflow-hidden transition-[max-height] duration-500 ease-in-out motion-reduce:transition-none"
            )}
            style={
              collapsible
                ? { maxHeight: expanded ? `${contentHeight}px` : "20rem" }
                : undefined
            }
          >
            <MarkdownEditor
              animateAppend={streaming}
              markdown={markdown}
              readOnly
              onFileLinkClick={onFileLinkClick}
              placeholder=""
              minHeight="min-h-0"
            />
          </div>
          {collapsible && contentOverflows ? (
            <Button
              aria-label={
                expanded ? "Replier la réponse" : "Afficher la réponse complète"
              }
              className="sub-agent-response-toggle absolute bottom-2 left-1/2 z-2 -translate-x-1/2 rounded-full shadow-sm transition-[background-color,transform] duration-300 motion-reduce:transition-none"
              onClick={() => setExpanded((value) => !value)}
              size="icon-sm"
              type="button"
              variant="outline"
            >
              {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
            </Button>
          ) : null}
        </div>
        <MarkdownMessageActions
          alwaysVisible={alwaysVisible}
          createdAt={createdAt}
          markdown={markdown}
          showFeedback={showFeedback}
        />
      </div>
    </div>
  )
}

function AgentErrorTimelineItem({
  actionUrl,
  alwaysVisible,
  createdAt,
  detail,
  errorCode,
  resetAt,
}: {
  actionUrl?: string
  alwaysVisible: boolean
  createdAt: string
  detail: string
  errorCode?: UserStoryAgentActivity["errorCode"]
  resetAt?: string
}) {
  const platform = usePlatform()
  const entering = useEnterAnimation(createdAt)
  return (
    <div
      className={cn(
        "group/message grid min-w-0 gap-2",
        entering && "chat-enter-agent"
      )}
      role="alert"
    >
      <div className="flex min-w-0 gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-destructive shadow-sm">
        <AlertCircleIcon className="mt-0.5 size-5 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">Agent error</p>
          <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap">
            {detail}
          </p>
          {resetAt ? (
            <p className="mt-2 text-xs">{clineLimitResetLabel(resetAt)}</p>
          ) : null}
          {actionUrl && platform.openExternalLink ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => platform.openExternalLink?.(actionUrl)}
            >
              <ExternalLinkIcon />
              {clineErrorActionLabel(errorCode)}
            </Button>
          ) : null}
        </div>
      </div>
      <MarkdownMessageActions
        alwaysVisible={alwaysVisible}
        createdAt={createdAt}
        markdown={detail}
      />
    </div>
  )
}

function clineErrorActionLabel(errorCode: UserStoryAgentActivity["errorCode"]) {
  return errorCode === "cline_not_subscribed"
    ? "View ClinePass"
    : "Manage ClinePass"
}

function clineLimitResetLabel(resetAt: string) {
  const date = new Date(resetAt)
  return Number.isNaN(date.getTime())
    ? `Limit resets ${resetAt}.`
    : `Limit resets ${date.toLocaleString()}.`
}

function modelSwitched(
  previous: AgentConversationRun | undefined,
  run: AgentConversationRun
) {
  if (!previous?.modelId || !run.modelId) return false
  return (
    previous.modelId !== run.modelId ||
    previous.providerId !== run.providerId ||
    (previous.reasoningEffort ?? null) !== (run.reasoningEffort ?? null)
  )
}

function ModelSwitchNote({
  responseHeader,
  run,
}: {
  responseHeader: AgentConversationResponseHeader
  run: AgentConversationRun
}) {
  const reasoning = run.reasoningEffort
    ? ` · ${getVariantLabel(run.reasoningEffort)} reasoning`
    : ""
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5">
        <ProviderMark provider={responseHeader.provider} />
        Continued with{" "}
        {responseHeader.modelName ?? responseHeader.provider.name}
        {reasoning}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

function UserMessageAvatar({ author }: { author: string }) {
  return <CurrentUserAvatar fallbackName={author} />
}

function AgentResponseAvatar({
  activity,
  responseHeader,
}: {
  activity: UserStoryAgentActivity
  responseHeader: AgentConversationResponseHeader
}) {
  const specialistAppearance = specialistAgentAppearance(activity)
  const avatar = activity.agentAvatar ?? specialistAppearance?.avatar
  if (avatar) {
    const name = activity.agentName ?? "Agent"
    return (
      <Avatar aria-label={name}>
        <AvatarImage alt={name} src={avatar} />
        <AvatarFallback>{agentInitials(name)}</AvatarFallback>
      </Avatar>
    )
  }

  return (
    <span
      aria-label={activity.agentName ?? responseHeader.provider.name}
      className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-background"
    >
      <ProviderMark provider={responseHeader.provider} />
    </span>
  )
}

function specialistAgentAppearance(activity: UserStoryAgentActivity) {
  if (activity.messageKind !== "intermediate" || !activity.agentName) {
    return undefined
  }
  return specialistAgentAppearanceByName(activity.agentName)
}

function specialistAgentAppearanceByName(name: string | undefined) {
  return name ? specialistAgentAppearances[name] : undefined
}

function agentInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
}

export function MarkdownMessageActions({
  alwaysVisible = true,
  createdAt,
  markdown,
  onUndo,
  showFeedback,
  undoDisabled,
}: {
  alwaysVisible?: boolean
  createdAt?: string | null
  markdown: string
  onUndo?: () => Promise<void> | void
  showFeedback?: boolean
  undoDisabled?: boolean
}) {
  const [feedback, setFeedback] = React.useState<"dislike" | "like">()
  const [undoing, setUndoing] = React.useState(false)
  const dateLabel = messageActionDateLabel(createdAt)

  async function copy() {
    try {
      await writeClipboardText(markdown)
      toast.success("Message copied.", { position: "bottom-right" })
    } catch (error) {
      toast.error("Unable to copy", {
        description: errorMessage(error),
        position: "bottom-right",
      })
    }
  }

  async function undo() {
    if (!onUndo || undoing) return
    setUndoing(true)
    try {
      await onUndo()
    } catch (error) {
      toast.error("Unable to undo message", {
        description: errorMessage(error),
        position: "bottom-right",
      })
    } finally {
      setUndoing(false)
    }
  }

  function preventMouseFocus(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
  }

  return (
    <div
      className={cn(
        "flex min-h-6 items-center gap-3 transition-opacity",
        alwaysVisible
          ? "opacity-100"
          : "pointer-events-none opacity-0 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100"
      )}
    >
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {dateLabel ? (
          <time
            className="shrink-0 text-xs font-medium text-muted-foreground"
            dateTime={createdAt ?? undefined}
          >
            {dateLabel}
          </time>
        ) : null}
        <div className="flex shrink-0 items-center gap-1.5">
          <MarkdownActionTooltip label="Copy">
            <Button
              aria-label="Copy"
              onMouseDown={preventMouseFocus}
              onClick={copy}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <CopyIcon className="size-3" />
            </Button>
          </MarkdownActionTooltip>
          {onUndo ? (
            <MarkdownActionTooltip label={undoing ? "Undoing" : "Undo"}>
              <Button
                aria-label={undoing ? "Undoing" : "Undo"}
                disabled={undoDisabled || undoing}
                onMouseDown={preventMouseFocus}
                onClick={undo}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <RotateCcwIcon className="size-3" />
              </Button>
            </MarkdownActionTooltip>
          ) : null}
          {showFeedback ? (
            <>
              <MarkdownActionTooltip label="Like">
                <Button
                  aria-label="Like"
                  aria-pressed={feedback === "like"}
                  className={
                    feedback === "like"
                      ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
                      : undefined
                  }
                  onClick={() =>
                    setFeedback(feedback === "like" ? undefined : "like")
                  }
                  onMouseDown={preventMouseFocus}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <ThumbsUpIcon className="size-3" />
                </Button>
              </MarkdownActionTooltip>
              <MarkdownActionTooltip label="Dislike">
                <Button
                  aria-label="Dislike"
                  aria-pressed={feedback === "dislike"}
                  className={
                    feedback === "dislike"
                      ? "bg-destructive/10 text-destructive hover:!bg-destructive/15 dark:bg-destructive/20 dark:hover:!bg-destructive/30"
                      : undefined
                  }
                  onClick={() =>
                    setFeedback(feedback === "dislike" ? undefined : "dislike")
                  }
                  onMouseDown={preventMouseFocus}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <ThumbsDownIcon className="size-3" />
                </Button>
              </MarkdownActionTooltip>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function MarkdownActionTooltip({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function agentDisplayActivities(run: AgentConversationRun) {
  const activities = run.activities ?? []
  const markdown = run.finalResponse?.trim()
  const last = activities.at(-1)
  if (!markdown) return activities
  if (last?.kind !== "message") {
    return finalResponseActivities(run, activities, markdown)
  }
  const finalDetail = sameStreamingMarkdown(last.detail, markdown)
    ? markdown
    : last.detail
  if (run.status !== "completed" && finalDetail === last.detail)
    return activities
  if (run.status === "completed" && finalDetail !== markdown) {
    return finalResponseActivities(run, activities, markdown)
  }
  return [
    ...activities.slice(0, -1),
    {
      ...last,
      detail: finalDetail,
      messageKind: "final" as const,
      status: "completed" as const,
      title: "Agent response",
    },
  ]
}

function agentTimelineActivities(run: AgentConversationRun) {
  const activities = agentDisplayActivities(run)
  const failure = failedRunResponse(run)
  if (!failure) return activities
  const hasVisibleResponse = activities.some(
    (activity) => activity.kind === "message" || activity.kind === "error"
  )
  return hasVisibleResponse ? activities : [...activities, failure]
}

const emptyAgentStreamOrder = { activityIds: [], revision: 0 }

function mergedActivityIds(
  persisted: UserStoryAgentActivity[],
  liveIds: string[]
) {
  if (!liveIds.length) return persisted.map((activity) => activity.id)
  const ids = [...liveIds]
  const known = new Set(ids)
  persisted.forEach((activity) => {
    const activityId = activity.id
    if (known.has(activityId)) return
    known.add(activityId)
    ids.push(activityId)
  })
  return ids
}

function finalResponseActivities(
  run: AgentConversationRun,
  activities: UserStoryAgentActivity[],
  markdown: string
) {
  if (run.status !== "completed") return activities
  return [
    ...activities,
    {
      createdAt: run.completedAt ?? run.updatedAt ?? run.createdAt,
      detail: markdown,
      id: `${run.id}-final-response`,
      kind: "message" as const,
      messageKind: "final" as const,
      status: "completed" as const,
      title: "Agent response",
    },
  ]
}

function failedRunResponse(
  run: AgentConversationRun
): UserStoryAgentActivity | undefined {
  if (run.status !== "failed" && run.status !== "cancelled") return undefined
  const response = agentErrorText(run.finalResponse ?? "")
  return {
    createdAt: run.completedAt ?? run.updatedAt ?? run.createdAt,
    detail: response || "Agent session failed.",
    id: `${run.id}-failed-response`,
    kind: "error",
    status: "failed",
    title: "Agent error",
  }
}

function sameStreamingMarkdown(left: string | undefined, right: string) {
  const normalizedLeft = normalizedMarkdown(left ?? "")
  const normalizedRight = normalizedMarkdown(right)
  if (!normalizedLeft) return false
  return (
    normalizedLeft === normalizedRight ||
    normalizedRight.startsWith(normalizedLeft) ||
    sameLeadingMarkdown(normalizedLeft, normalizedRight)
  )
}

function sameLeadingMarkdown(left: string, right: string) {
  const prefixLength = Math.min(left.length, right.length, 80)
  if (prefixLength < 40) return false
  return left.slice(0, prefixLength) === right.slice(0, prefixLength)
}

function normalizedMarkdown(value: string) {
  return value.trim().replace(/\r\n?/g, "\n")
}

async function writeClipboardText(value: string) {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard is not available.")
  }
  await navigator.clipboard.writeText(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function commentDateLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Just now"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

function messageActionDateLabel(value: string | null | undefined) {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

function runComment(
  run: AgentConversationRun,
  commentsById: Map<string, AgentConversationComment>
) {
  const commentId = run.commentId ?? run.messageId
  return commentId ? commentsById.get(commentId) : undefined
}

// Only items that arrived in the last few seconds animate in. Opening a
// conversation shows its history at once instead of replaying every entrance.
const freshItemWindowMs = 15_000

function isFreshTimestamp(value: string | null | undefined) {
  if (!value) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && Date.now() - time < freshItemWindowMs
}

// Decided once, at mount, so the class never flips during streaming.
function useEnterAnimation(createdAt: string | null | undefined) {
  const [entering] = React.useState(() => isFreshTimestamp(createdAt))
  return entering
}

// "Draft saved" appears once typing pauses: drafts are kept per conversation
// and per story, so closing the app never loses what was being written.
function DraftSavedHint({
  hidden,
  message,
}: {
  hidden?: boolean
  message: string
}) {
  const [saved, setSaved] = React.useState(false)
  const hasText = Boolean(message.trim())
  React.useEffect(() => {
    const reset = requestAnimationFrame(() => setSaved(false))
    if (!hasText) return () => cancelAnimationFrame(reset)
    const timer = window.setTimeout(() => setSaved(true), 900)
    return () => {
      cancelAnimationFrame(reset)
      window.clearTimeout(timer)
    }
  }, [hasText, message])
  return (
    <span
      aria-live="polite"
      className={cn(
        "pointer-events-none absolute bottom-full left-5 z-10 mb-1.5 flex items-center gap-1 text-[11px] text-muted-foreground transition-opacity duration-300",
        saved && hasText && !hidden ? "opacity-100" : "opacity-0"
      )}
    >
      <CheckIcon className="size-3" /> Draft saved
    </span>
  )
}
