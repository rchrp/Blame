import { approveActionLabel } from "@/components/backlog/shared/backlog-helpers"
import { Trash2Icon } from "lucide-react"

import {
  type UserStory,
  userStoryActions,
} from "@/components/backlog/data/backlog-data"
import type { UserStoryDiffStats } from "@/components/backlog/development/user-story-diff-stats"
import type { OpenDrawer } from "@/components/backlog/shared/backlog-types"
import {
  type StoryActionHandler,
  StoryAction,
} from "@/components/backlog/actions/story-action-button"
import {
  type RejectChoice,
  type StopAgentChoice,
  DeleteUserStoryDialog,
  RejectDialog,
  StopAgentDialog,
} from "@/components/backlog/actions/story-action-dialogs"
import { Separator } from "@/components/ui/separator"

export function StoryActions({
  diffStats,
  onAction,
  onOpenDrawer,
  onOpenWorktree,
  onDeleteUserStory,
  onReject,
  reviewDiffEmpty,
  onStopAgent,
  onUnpauseAgent,
  story,
}: {
  diffStats?: UserStoryDiffStats
  onAction: StoryActionHandler
  onOpenDrawer: OpenDrawer
  onOpenWorktree: (story: UserStory) => Promise<void>
  onDeleteUserStory: (story: UserStory) => Promise<void>
  onReject: (story: UserStory, choice: RejectChoice) => Promise<UserStory>
  reviewDiffEmpty?: boolean
  onStopAgent: (story: UserStory, choice: StopAgentChoice) => Promise<UserStory>
  onUnpauseAgent: (story: UserStory) => Promise<UserStory>
  story: UserStory
}) {
  if (story.status === "in-review") {
    return (
      <ReviewActions
        diffStats={diffStats}
        onAction={onAction}
        onOpenDrawer={onOpenDrawer}
        onOpenWorktree={onOpenWorktree}
        onReject={onReject}
        reviewDiffEmpty={reviewDiffEmpty}
        story={story}
      />
    )
  }

  if (story.status === "in-progress") {
    return (
      <ProgressActions
        diffStats={diffStats}
        onAction={onAction}
        onOpenDrawer={onOpenDrawer}
        onOpenWorktree={onOpenWorktree}
        onStopAgent={onStopAgent}
        onUnpauseAgent={onUnpauseAgent}
        story={story}
      />
    )
  }

  return (
    <div className="flex w-full justify-end gap-2">
      {userStoryActions(story).map((action) => (
        <UserStoryAction
          key={action}
          action={action}
          diffStats={diffStats}
          onAction={onAction}
          onDeleteUserStory={onDeleteUserStory}
          onOpenDrawer={onOpenDrawer}
          onOpenWorktree={onOpenWorktree}
          onStopAgent={onStopAgent}
          onUnpauseAgent={onUnpauseAgent}
          story={story}
        />
      ))}
    </div>
  )
}

function UserStoryAction({
  action,
  diffStats,
  onAction,
  onDeleteUserStory,
  onOpenDrawer,
  onOpenWorktree,
  onStopAgent,
  onUnpauseAgent,
  story,
}: {
  action: ReturnType<typeof userStoryActions>[number]
  diffStats?: UserStoryDiffStats
  onAction: StoryActionHandler
  onDeleteUserStory: (story: UserStory) => Promise<void>
  onOpenDrawer: OpenDrawer
  onOpenWorktree: (story: UserStory) => Promise<void>
  onStopAgent: (story: UserStory, choice: StopAgentChoice) => Promise<UserStory>
  onUnpauseAgent: (story: UserStory) => Promise<UserStory>
  story: UserStory
}) {
  if (action === "Delete Permanently") {
    return (
      <DeleteUserStoryDialog
        onDeleteUserStory={onDeleteUserStory}
        story={story}
        triggerIconOnly
        triggerSize="icon-sm"
      />
    )
  }

  return (
    <StoryAction
      action={action}
      diffStats={diffStats}
      className={
        story.status === "done" && action === "View Diff" ? "flex-1" : undefined
      }
      label={
        story.status === "done" && action === "View Diff" ? "Diff" : undefined
      }
      onAction={onAction}
      onOpenDrawer={onOpenDrawer}
      onOpenWorktree={onOpenWorktree}
      onStopAgent={onStopAgent}
      onUnpauseAgent={onUnpauseAgent}
      story={story}
    />
  )
}

function ProgressActions({
  diffStats,
  onAction,
  onOpenDrawer,
  onOpenWorktree,
  onStopAgent,
  onUnpauseAgent,
  story,
}: {
  diffStats?: UserStoryDiffStats
  onAction: StoryActionHandler
  onOpenDrawer: OpenDrawer
  onOpenWorktree: (story: UserStory) => Promise<void>
  onStopAgent: (story: UserStory, choice: StopAgentChoice) => Promise<UserStory>
  onUnpauseAgent: (story: UserStory) => Promise<UserStory>
  story: UserStory
}) {
  return (
    <div className="grid w-full gap-2">
      <DevelopmentActions
        diffStats={diffStats}
        onOpenDrawer={onOpenDrawer}
        story={story}
      />
      <Separator className="my-1" />
      <WorkspaceActions
        onAction={onAction}
        onOpenDrawer={onOpenDrawer}
        onOpenWorktree={onOpenWorktree}
        story={story}
      />
      <div className="flex justify-end gap-2">
        {story.agentStatus === "Paused" && (
          <StoryAction
            action="Unpause Agent"
            onAction={onAction}
            onOpenDrawer={onOpenDrawer}
            onOpenWorktree={onOpenWorktree}
            onUnpauseAgent={onUnpauseAgent}
            story={story}
          />
        )}
        <StopAgentDialog
          onOpenDrawer={onOpenDrawer}
          onStopAgent={onStopAgent}
          story={story}
        />
      </div>
    </div>
  )
}

function ReviewActions({
  diffStats,
  onAction,
  onOpenDrawer,
  onOpenWorktree,
  onReject,
  reviewDiffEmpty,
  story,
}: {
  diffStats?: UserStoryDiffStats
  onAction: StoryActionHandler
  onOpenDrawer: OpenDrawer
  onOpenWorktree: (story: UserStory) => Promise<void>
  onReject: (story: UserStory, choice: RejectChoice) => Promise<UserStory>
  reviewDiffEmpty?: boolean
  story: UserStory
}) {
  return (
    <div className="grid w-full gap-2">
      <DevelopmentActions
        diffStats={diffStats}
        onOpenDrawer={onOpenDrawer}
        story={story}
      />
      <Separator className="my-1" />
      <WorkspaceActions
        onAction={onAction}
        onOpenDrawer={onOpenDrawer}
        onOpenWorktree={onOpenWorktree}
        story={story}
      />
      <div className="grid grid-cols-2 gap-2">
        {reviewDiffEmpty ? (
          <StoryAction
            action="Discard"
            className="w-full"
            icon={Trash2Icon}
            iconOnly={false}
            label="Discard"
            onAction={onAction}
            onOpenDrawer={onOpenDrawer}
            onOpenWorktree={onOpenWorktree}
            story={story}
          />
        ) : (
          <RejectDialog
            onOpenDrawer={onOpenDrawer}
            onReject={onReject}
            story={story}
          />
        )}
        <StoryAction
          action="Approve & Merge"
          label={approveActionLabel(story, reviewDiffEmpty)}
          onAction={onAction}
          onOpenDrawer={onOpenDrawer}
          onOpenWorktree={onOpenWorktree}
          story={story}
        />
      </div>
    </div>
  )
}

function DevelopmentActions({
  diffStats,
  onOpenDrawer,
  story,
}: {
  diffStats?: UserStoryDiffStats
  onOpenDrawer: OpenDrawer
  story: UserStory
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <StoryAction
        action="View Diff"
        diffStats={diffStats}
        label="Diff"
        onOpenDrawer={onOpenDrawer}
        story={story}
      />
      <StoryAction
        action="View Files"
        label="Files"
        onOpenDrawer={onOpenDrawer}
        story={story}
      />
      <StoryAction
        action="View Terminal"
        label="Terminal"
        onOpenDrawer={onOpenDrawer}
        story={story}
      />
    </div>
  )
}

// Where the story's files live. Direct stories run in the project folder
// and have no managed preview.
function WorkspaceActions({
  onAction,
  onOpenDrawer,
  onOpenWorktree,
  story,
}: {
  onAction: StoryActionHandler
  onOpenDrawer: OpenDrawer
  onOpenWorktree: (story: UserStory) => Promise<void>
  story: UserStory
}) {
  const direct = story.workspaceMode === "direct"
  return (
    <div className="grid grid-cols-2 gap-2">
      <StoryAction
        action="Open Worktree"
        className={direct ? "col-span-2" : undefined}
        label={direct ? "Open Project Folder" : undefined}
        onAction={onAction}
        onOpenDrawer={onOpenDrawer}
        onOpenWorktree={onOpenWorktree}
        story={story}
      />
      {direct ? null : (
        <StoryAction
          action="Open Preview"
          onAction={onAction}
          onOpenDrawer={onOpenDrawer}
          onOpenWorktree={onOpenWorktree}
          story={story}
        />
      )}
    </div>
  )
}
