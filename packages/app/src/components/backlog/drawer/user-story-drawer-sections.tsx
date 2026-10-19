import * as React from "react"

import type {
  BacklogColumnId,
  UserStory,
  UserStoryAgentActivity,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import { createBacklogApi } from "@/components/backlog/data/backlog-api"
import type { PendingCodeSelectionAttachment } from "@/components/backlog/shared/comment-attachment-events"
import type { UserStoryDrawerMode } from "@/components/backlog/shared/backlog-types"
import type { VcsFileDiff } from "@/components/backlog/development/development-workspace"
import {
  MarkdownEditor,
  type PendingFileAttachment,
} from "@/components/backlog/drawer/markdown-editor"
import { RuntimeProfileSelector } from "@/components/backlog/drawer/runtime-profile-selector"
import type { StoryRunMode } from "@/lib/runtime-preference"
import {
  commentButtonLabel,
  isEditable,
} from "@/components/backlog/drawer/user-story-drawer-helpers"
import {
  AgentConversationComposer,
  AgentConversationTimeline,
  MarkdownMessageActions,
  type AgentConversationUserMessageUndo,
} from "@/components/chat/agent-conversation"
import { agentConversationResponseHeader } from "@/components/chat/agent-conversation-header"
import {
  agentTurnMetricsTarget,
  useAgentTurnMetrics,
} from "@/components/chat/agent-turn-metrics"
import { ModelSelector } from "@/components/model/model-selector"
import {
  saveStoryModelChoice,
  useStoryModelChoice,
} from "@/components/backlog/data/story-model-choice"
import type { CloudAiModelPreference } from "@/context/cloud-auth"
import { useModelSelection } from "@/components/model/model-selection"
import { useProjects } from "@/context/projects"
import { useCloudAuth } from "@/context/cloud-auth"
import { useLatestCallback } from "@/lib/use-latest-callback"
import { QueuedComments } from "@/components/backlog/drawer/queued-comments"
import { commentsWithoutAgentRun } from "./user-story-comment-submission"

const commentComposerBlurMask = {
  maskImage: "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
  WebkitMaskImage:
    "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
} satisfies React.CSSProperties

type UserStoryCommentComposerProps = {
  commentCodeSelectionAttachments: PendingCodeSelectionAttachment[]
  commentFileAttachments: PendingFileAttachment[]
  comment: string
  commentEditorKey: number
  commentRef: React.RefObject<HTMLDivElement | null>
  commentSubmitting: boolean
  onCommentChange: (comment: string) => void
  onCommentCodeSelectionAttachmentRemove: (id: string) => void
  onCommentFileAttachmentRemove: (id: string) => void
  onCommentFileAttachmentsAdd: (attachments: UserStoryFileAttachment[]) => void
  onCommentSubmit: () => void
  // Pauses the running agent (the composer's stop button).
  onAgentPause?: () => void
  onFileLinkClick?: (path: string) => void
  status: BacklogColumnId
  userStory?: UserStory
}

type UserStoryFixedSectionProps = UserStoryCommentComposerProps & {
  actions?: React.ReactNode
  mode: UserStoryDrawerMode
}

export const UserStoryContent = React.memo(function UserStoryContent({
  mode,
  onCommentUndo,
  onSummaryChange,
  onSummaryCodeSelectionAttachmentRemove,
  onSummaryFileAttachmentRemove,
  onSummaryFileAttachmentsAdd,
  onSummaryOptimize,
  onFileLinkClick,
  onChangedFileClick,
  onRunModeChange,
  loadChangedFileDiffs,
  runMode,
  status,
  summary,
  summaryCodeSelectionAttachments,
  summaryFileAttachments,
  summaryRef,
  userStory,
}: {
  loadChangedFileDiffs?: Parameters<
    typeof AgentConversationTimeline
  >[0]["loadChangedFileDiffs"]
  mode: UserStoryDrawerMode
  // Where this story runs (Local Container, Cloud Preview or Direct).
  runMode?: StoryRunMode | null
  onRunModeChange?: (mode: StoryRunMode) => void
  onCommentUndo?: (target: AgentConversationUserMessageUndo) => Promise<void>
  onSummaryChange?: (summary: string) => void
  onSummaryCodeSelectionAttachmentRemove: (id: string) => void
  onSummaryFileAttachmentRemove: (id: string) => void
  onSummaryFileAttachmentsAdd: (attachments: UserStoryFileAttachment[]) => void
  onSummaryOptimize?: (summary: string) => Promise<string>
  onFileLinkClick?: (path: string) => void
  onChangedFileClick?: (path: string, diffs: VcsFileDiff[]) => void
  status: BacklogColumnId
  summary: string
  summaryCodeSelectionAttachments: PendingCodeSelectionAttachment[]
  summaryFileAttachments: PendingFileAttachment[]
  summaryRef: React.RefObject<HTMLDivElement | null>
  userStory?: UserStory
}) {
  const project = useProjects().activeProject
  const mentionDirectory = useFileMentionDirectory(status, userStory)
  const editable = isEditable(mode, status)
  const stableLoadChangedFileDiffs = useLatestCallback(
    (sessionId: string, checkpointRunCount: number, diffEndRef: string) =>
      loadChangedFileDiffs?.(sessionId, checkpointRunCount, diffEndRef) ??
      Promise.resolve([])
  )
  const stableOnCommentUndo = useLatestCallback(
    async (target: AgentConversationUserMessageUndo) => {
      await onCommentUndo?.(target)
    }
  )
  const stableOnFileLinkClick = useLatestCallback((path: string) => {
    onFileLinkClick?.(path)
  })
  const stableOnChangedFileClick = useLatestCallback(
    (path: string, diffs: VcsFileDiff[]) => {
      onChangedFileClick?.(path, diffs)
    }
  )
  return (
    <>
      <div className="group/message grid gap-3">
        <MarkdownEditor
          speechSessionKey={`backlog-summary:${project?.id}:${userStory?.id ?? "new"}`}
          codeSelectionAttachments={summaryCodeSelectionAttachments}
          fileAttachments={summaryFileAttachments}
          mentionDirectory={mentionDirectory}
          ref={summaryRef}
          markdown={summary}
          onCodeSelectionAttachmentRemove={
            onSummaryCodeSelectionAttachmentRemove
          }
          onFileAttachmentRemove={onSummaryFileAttachmentRemove}
          onFileAttachmentsAdd={onSummaryFileAttachmentsAdd}
          onFileLinkClick={onFileLinkClick}
          onMarkdownChange={onSummaryChange}
          onOptimize={onSummaryOptimize}
          readOnly={!editable}
          toolbarEnd={
            editable ? (
              <div className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2">
                <RuntimeProfileSelector value={runMode} onChange={onRunModeChange} />
                <div className="w-96 shrink-0">
                  <MarkdownEditorModelSelector />
                </div>
              </div>
            ) : undefined
          }
          placeholder="Describe the user story, expected behavior, and acceptance criteria."
          minHeight="min-h-80"
          maxHeight="max-h-180"
        />
        {summary.trim() ? (
          <MarkdownMessageActions
            alwaysVisible={summaryActionsAlwaysVisible(userStory)}
            createdAt={userStory?.createdAt}
            markdown={summary}
          />
        ) : null}
      </div>
      <div className="mx-auto w-full max-w-4xl">
        <AgentRunTimeline
          loadChangedFileDiffs={
            loadChangedFileDiffs ? stableLoadChangedFileDiffs : undefined
          }
          connectSummaryActions={Boolean(summary.trim())}
          userStory={userStory}
          onFileLinkClick={onFileLinkClick ? stableOnFileLinkClick : undefined}
          onChangedFileClick={
            onChangedFileClick ? stableOnChangedFileClick : undefined
          }
          onCommentUndo={
            status === "in-review" && onCommentUndo
              ? stableOnCommentUndo
              : undefined
          }
        />
      </div>
    </>
  )
})

export const UserStoryFixedSection = React.memo(function UserStoryFixedSection({
  actions,
  mode,
  ...commentComposerProps
}: UserStoryFixedSectionProps) {
  const commentComposerVisible = mode !== "create"

  if (!commentComposerVisible && !actions) return null

  return (
    <div className={fixedSectionClassName(commentComposerVisible)}>
      <div
        className="pointer-events-none absolute inset-0 bg-background/40 backdrop-blur-xl"
        style={commentComposerBlurMask}
      />
      <div className="relative grid gap-3">
        {commentComposerVisible ? (
          <div className="mx-auto w-full max-w-4xl">
            <UserStoryCommentComposer {...commentComposerProps} />
          </div>
        ) : null}
        {actions ? (
          <div className="flex w-full justify-end">{actions}</div>
        ) : null}
      </div>
    </div>
  )
})

function UserStoryCommentComposer({
  commentCodeSelectionAttachments,
  commentFileAttachments,
  comment,
  commentEditorKey,
  commentRef,
  commentSubmitting,
  onCommentChange,
  onCommentCodeSelectionAttachmentRemove,
  onCommentFileAttachmentRemove,
  onCommentFileAttachmentsAdd,
  onCommentSubmit,
  onAgentPause,
  onFileLinkClick,
  status,
  userStory,
}: UserStoryCommentComposerProps) {
  const agentRunning =
    status === "in-progress" && userStory?.agentStatus === "Running"
  const project = useProjects().activeProject
  const mentionDirectory = useFileMentionDirectory(status, userStory)
  const metricsTarget = agentTurnMetricsTarget(
    userStory?.comments ?? [],
    userStory?.agentRuns ?? [],
    (run) => run.commentId
  )
  const turnMetrics = useAgentTurnMetrics({
    root: userStory?.worktree ?? mentionDirectory,
    run: metricsTarget?.run,
    startedAt: metricsTarget?.startedAt,
  })

  return (
    <AgentConversationComposer
      agentRunning={agentRunning}
      onAgentCancel={onAgentPause}
      queueWhileRunning
      speechSessionKey={`backlog-comment:${project?.id}:${userStory?.id}`}
      codeSelectionAttachments={commentCodeSelectionAttachments}
      disabled={status === "done"}
      submitting={commentSubmitting}
      editorKey={commentEditorKey}
      editorRef={commentRef}
      fileAttachments={commentFileAttachments}
      mentionDirectory={mentionDirectory}
      message={comment}
      onCodeSelectionAttachmentRemove={onCommentCodeSelectionAttachmentRemove}
      onFileAttachmentRemove={onCommentFileAttachmentRemove}
      onFileAttachmentsAdd={onCommentFileAttachmentsAdd}
      onFileLinkClick={onFileLinkClick}
      onMessageChange={onCommentChange}
      onMessageSubmit={onCommentSubmit}
      placeholder={
        agentRunning
          ? "Message the agent: it reads it when it finishes, or now if you choose"
          : commentPlaceholder(status)
      }
      submitLabel={agentRunning ? "Queue comment" : commentButtonLabel(status)}
      toolbarEnd={
        userStory && status !== "done" ? (
          <StoryCommentModelSelector userStory={userStory} />
        ) : undefined
      }
      turnMetrics={turnMetrics}
    />
  )
}

// Picks the model and reasoning of this story's next turn, without changing
// the default used by new stories.
const StoryCommentModelSelector = React.memo(function StoryCommentModelSelector({
  userStory,
}: {
  userStory: UserStory
}) {
  const preference = useStoryModelChoice(userStory)
  const storyId = userStory.id
  const scope = React.useMemo(
    () => ({
      preference,
      onChange: (next: CloudAiModelPreference) =>
        saveStoryModelChoice(storyId, next),
    }),
    [preference, storyId]
  )
  return (
    <div className="w-80 max-w-full min-w-0">
      <ModelSelector modelTriggerClassName="max-w-none" role="agent" scope={scope} />
    </div>
  )
})

function commentPlaceholder(status: BacklogColumnId) {
  if (status === "done") return "Comments are read-only after merge."
  return "Add a comment"
}

function fixedSectionClassName(commentComposerVisible: boolean) {
  if (commentComposerVisible) {
    return "pointer-events-auto relative -mx-6 px-6 pt-4 pb-6"
  }
  return "pointer-events-auto relative -mx-6 px-6 pt-6 pb-6"
}

function useFileMentionDirectory(
  status: BacklogColumnId,
  userStory: UserStory | undefined
) {
  const projects = useProjects()
  return fileMentionDirectory(status, userStory, projects.activeProject?.path)
}

const AgentRunTimeline = React.memo(function AgentRunTimeline({
  connectSummaryActions,
  loadChangedFileDiffs,
  onCommentUndo,
  onFileLinkClick,
  onChangedFileClick,
  userStory,
}: AgentRunTimelineProps) {
  const auth = useCloudAuth()
  const api = React.useMemo(
    () => createBacklogApi(auth.apiConnection),
    [auth.apiConnection]
  )
  const modelSelection = useModelSelection()
  const responseHeader = agentConversationResponseHeader({
    modelId: userStory?.agentModelId,
    providerId: userStory?.agentProviderId,
    providers: modelSelection.allProviders,
  })
  const providers = modelSelection.allProviders
  const responseHeaderForRun = React.useCallback(
    (run: { modelId?: string | null; providerId?: string | null }) =>
      run.providerId && run.modelId
        ? agentConversationResponseHeader({
            modelId: run.modelId,
            providerId: run.providerId,
            providers,
          })
        : undefined,
    [providers]
  )
  const loadActivityDetail = React.useCallback(
    async (run: { id: string }, activity: UserStoryAgentActivity) => {
      if (!userStory) return activity.detail
      return (
        await api.agentRunActivityDetail(userStory.id, run.id, activity.id)
      ).detail
    },
    [api, userStory]
  )

  return (
    <AgentConversationTimeline
      comments={userStory?.comments ?? []}
      unsentComments={commentsWithoutAgentRun(userStory ?? {})}
      loadChangedFileDiffs={loadChangedFileDiffs}
      onFileLinkClick={onFileLinkClick}
      onChangedFileClick={onChangedFileClick}
      onLoadActivityDetail={loadActivityDetail}
      onUserMessageUndo={onCommentUndo}
      responseHeader={responseHeader}
      responseHeaderForRun={responseHeaderForRun}
      queued={
        <QueuedComments
          author={userStory?.comments?.at(-1)?.author ?? "You"}
          onFileLinkClick={onFileLinkClick}
          storyId={userStory?.id}
        />
      }
      runs={userStory?.agentRuns ?? []}
      topOffset={connectSummaryActions ? "message-actions" : "default"}
    />
  )
})

type AgentRunTimelineProps = {
  connectSummaryActions?: boolean
  loadChangedFileDiffs?: Parameters<
    typeof AgentConversationTimeline
  >[0]["loadChangedFileDiffs"]
  onCommentUndo?: (target: AgentConversationUserMessageUndo) => Promise<void>
  onFileLinkClick?: (path: string) => void
  onChangedFileClick?: (path: string, diffs: VcsFileDiff[]) => void
  userStory?: UserStory
}

const MarkdownEditorModelSelector = React.memo(
  function ModelSelectorBoundary() {
    return <ModelSelector modelTriggerClassName="max-w-none" />
  }
)

function summaryActionsAlwaysVisible(userStory: UserStory | undefined) {
  const runs = userStory?.agentRuns ?? []
  if (!runs.length) return true
  return !runs.some(
    (run) =>
      run.kind !== "initial" ||
      (run.activities ?? []).some((activity) => activity.kind === "message")
  )
}

function fileMentionDirectory(
  status: BacklogColumnId,
  userStory: UserStory | undefined,
  projectPath: string | undefined
) {
  if (status === "backlog" || status === "ready") return projectPath
  if (status === "in-progress" || status === "in-review")
    return userStory?.worktree ?? undefined
}
