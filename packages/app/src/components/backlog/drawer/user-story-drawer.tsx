import * as React from "react"

import type {
  UserStory,
  UserStoryComment,
  UserStoryDraft,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import type {
  RejectChoice,
  StopAgentChoice,
} from "@/components/backlog/actions/story-action-dialogs"
import type {
  OpenDrawer,
  UserStoryDevelopmentTab,
  UserStoryDrawerMode,
  UserStoryDrawerTab,
} from "@/components/backlog/shared/backlog-types"
import type { AgentConversationUserMessageUndo } from "@/components/chat/agent-conversation"
import type { UserStoryDiffStats } from "@/components/backlog/development/user-story-diff-stats"
import { UserStoryDrawerPanel } from "@/components/backlog/drawer/user-story-drawer-panel"
import { Drawer } from "@/components/ui/drawer"

export type {
  UserStoryDevelopmentTab,
  UserStoryDrawerMode,
  UserStoryDrawerTab,
} from "@/components/backlog/shared/backlog-types"

export type UserStoryDrawerProps = {
  diffStats?: UserStoryDiffStats
  open: boolean
  onOpenChange: (open: boolean) => void
  userStory?: UserStory
  mode: UserStoryDrawerMode
  initialDraft?: Partial<Omit<UserStoryDraft, "projectId">>
  initialTab?: UserStoryDrawerTab
  initialDevelopmentTab?: UserStoryDevelopmentTab
  focusComment?: boolean
  onCreateUserStory: (
    input: Omit<UserStoryDraft, "projectId">,
    contextLimit?: number
  ) => Promise<UserStory>
  onCreateUserStoryComment: (
    story: UserStory,
    input: Pick<
      UserStoryComment,
      "body" | "codeSelectionAttachments" | "fileAttachments"
    >
  ) => Promise<UserStoryComment>
  onDeleteUserStory: (story: UserStory) => Promise<void>
  onApproveAndMerge: (story: UserStory) => Promise<UserStory>
  onOpenDrawer: OpenDrawer
  onOptimizeUserStory?: (input: {
    summary: string
    title: string
  }) => Promise<string>
  onReject: (story: UserStory, choice: RejectChoice) => Promise<UserStory>
  onRequestChanges: (
    story: UserStory,
    feedback: string,
    commentId: string,
    codeSelectionAttachments: UserStoryComment["codeSelectionAttachments"],
    fileAttachments: UserStoryComment["fileAttachments"]
  ) => Promise<UserStory | undefined>
  reviewDiffEmpty?: boolean
  onStopAgent: (story: UserStory, choice: StopAgentChoice) => Promise<UserStory>
  onUndoUserStoryComment: (
    story: UserStory,
    target: AgentConversationUserMessageUndo
  ) => Promise<UserStory>
  onUpdateUserStory: (
    story: UserStory,
    input: UserStoryUpdate
  ) => Promise<UserStory>
  setupInitializing?: boolean
  titleGenerating?: boolean
}

export const UserStoryDrawer = React.memo(function UserStoryDrawer({
  diffStats,
  open,
  onOpenChange,
  userStory,
  mode,
  initialDraft,
  initialTab = "user-story",
  initialDevelopmentTab = "files",
  focusComment,
  onCreateUserStory,
  onCreateUserStoryComment,
  onDeleteUserStory,
  onApproveAndMerge,
  onOpenDrawer,
  onOptimizeUserStory,
  onReject,
  onRequestChanges,
  reviewDiffEmpty,
  onStopAgent,
  onUndoUserStoryComment,
  onUpdateUserStory,
  setupInitializing,
  titleGenerating,
}: UserStoryDrawerProps) {
  const status = userStory?.status ?? "backlog"
  // The status is left out: a story that moves on stays where the person
  // is (same tab, scroll and drafts), it does not reopen.
  const drawerKey = [
    mode,
    userStory?.id ?? "draft",
    initialDraftKey(initialDraft),
    initialTab,
    initialDevelopmentTab,
    focusComment ? "comment" : "default",
  ].join(":")

  return (
    <Drawer
      autoFocus
      direction="right"
      open={open}
      onOpenChange={onOpenChange}
      handleOnly={true}
    >
      <UserStoryDrawerPanel
        key={drawerKey}
        diffStats={diffStats}
        focusComment={focusComment}
        initialDevelopmentTab={initialDevelopmentTab}
        initialDraft={initialDraft}
        initialTab={initialTab}
        mode={mode}
        open={open}
        onCancel={() => onOpenChange(false)}
        onApproveAndMerge={onApproveAndMerge}
        onCreateUserStory={onCreateUserStory}
        onCreateUserStoryComment={onCreateUserStoryComment}
        onDeleteUserStory={onDeleteUserStory}
        onOpenDrawer={onOpenDrawer}
        onOptimizeUserStory={onOptimizeUserStory}
        onRequestChanges={onRequestChanges}
        onReject={onReject}
        reviewDiffEmpty={reviewDiffEmpty}
        onStopAgent={onStopAgent}
        onUndoUserStoryComment={onUndoUserStoryComment}
        onUpdateUserStory={onUpdateUserStory}
        setupInitializing={setupInitializing}
        status={status}
        titleGenerating={titleGenerating}
        userStory={userStory}
      />
    </Drawer>
  )
})

function initialDraftKey(
  initialDraft: Partial<Omit<UserStoryDraft, "projectId">> | undefined
) {
  return [
    initialDraft?.title ?? "",
    initialDraft?.summary ?? "",
    ...(initialDraft?.fileAttachments ?? []).map((attachment) => attachment.id),
    ...(initialDraft?.codeSelectionAttachments ?? []).map(
      (attachment) => attachment.id
    ),
  ].join(":")
}
