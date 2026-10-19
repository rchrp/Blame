import * as React from "react"
import { approveActionLabel } from "@/components/backlog/shared/backlog-helpers"
import {
  CheckIcon,
  CircleStopIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import type {
  BacklogColumnId,
  UserStory,
} from "@/components/backlog/data/backlog-data"
import {
  type RejectChoice,
  RejectDialog,
  type StopAgentChoice,
  DeleteUserStoryDialog,
  StopAgentDialog,
} from "@/components/backlog/actions/story-action-dialogs"
import type {
  DrawerAction,
  OpenDrawer,
  UserStoryDrawerMode,
} from "@/components/backlog/shared/backlog-types"
import { drawerActions } from "@/components/backlog/drawer/user-story-drawer-helpers"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"

type DrawerActionConfig = {
  icon: React.ComponentType<{ className?: string }>
  variant: React.ComponentProps<typeof Button>["variant"]
  tone?: "primary" | "info"
  iconOnly?: boolean
}

const drawerActionConfig: Record<DrawerAction, DrawerActionConfig> = {
  Discard: {
    icon: XIcon,
    variant: "destructive",
    iconOnly: true,
  },
  "Save as Draft": {
    icon: CheckIcon,
    variant: "outline",
  },
  "Send to Dev Agent": {
    icon: LoaderCircleIcon,
    variant: "default",
    tone: "primary",
  },
  "Save Changes": {
    icon: CheckIcon,
    variant: "outline",
  },
  Dequeue: {
    icon: RotateCcwIcon,
    variant: "destructive",
  },
  "Stop Agent": {
    icon: CircleStopIcon,
    variant: "destructive",
  },
  "Request Changes": {
    icon: MessageSquareIcon,
    variant: "outline",
  },
  Reject: {
    icon: XIcon,
    variant: "destructive",
  },
  "Approve & Merge": {
    icon: CheckIcon,
    variant: "default",
    tone: "primary",
  },
  Close: {
    icon: XIcon,
    variant: "outline",
  },
  "Rework as Draft": {
    icon: RotateCcwIcon,
    variant: "default",
    tone: "primary",
  },
  "Delete Permanently": {
    icon: Trash2Icon,
    variant: "destructive",
  },
}

export function DrawerActions({
  loadingAction,
  mode,
  onAction,
  onDeleteUserStory,
  onOpenDrawer,
  onReject,
  onStopAgent,
  reviewDiffEmpty,
  status,
  story,
}: {
  loadingAction?: DrawerAction
  mode: UserStoryDrawerMode
  onAction: (action: DrawerAction) => void
  onDeleteUserStory: (story: UserStory) => Promise<void>
  onOpenDrawer: OpenDrawer
  onReject: (story: UserStory, choice: RejectChoice) => Promise<UserStory>
  onStopAgent: (story: UserStory, choice: StopAgentChoice) => Promise<UserStory>
  reviewDiffEmpty?: boolean
  status: BacklogColumnId
  story?: UserStory
}) {
  return (
    <div className="pointer-events-auto flex flex-wrap justify-start gap-2">
      {drawerActions(mode, status).map((action) => (
        <React.Fragment key={action}>
          {action === "Stop Agent" && story ? (
            <StopAgentDialog
              onOpenDrawer={onOpenDrawer}
              onStopAgent={onStopAgent}
              story={story}
              triggerSize="default"
            />
          ) : action === "Reject" && story ? (
            reviewDiffEmpty ? (
              <DrawerActionButton
                action={action}
                icon={Trash2Icon}
                label="Discard"
                loading={loadingAction === action}
                onClick={() => onAction(action)}
              />
            ) : (
              <RejectDialog
                onOpenDrawer={onOpenDrawer}
                onReject={onReject}
                story={story}
                triggerClassName="w-auto"
                triggerSize="default"
              />
            )
          ) : action === "Delete Permanently" && story ? (
            <DeleteUserStoryDialog
              onDeleteUserStory={onDeleteUserStory}
              story={story}
              triggerIconOnly
              triggerSize="icon"
            />
          ) : (
            <DrawerActionButton
              action={action}
              label={
                action === "Approve & Merge"
                  ? approveActionLabel(story, reviewDiffEmpty)
                  : undefined
              }
              loading={loadingAction === action}
              onClick={() => onAction(action)}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  )
}

function DrawerActionButton({
  action,
  icon,
  label,
  loading,
  onClick,
}: {
  action: DrawerAction
  icon?: DrawerActionConfig["icon"]
  label?: string
  loading: boolean
  onClick?: () => void
}) {
  const actionStyle = drawerActionConfig[action]
  const Icon = loading ? LoaderCircleIcon : (icon ?? actionStyle.icon)
  const isSendToDevAgent = action === "Send to Dev Agent"

  return (
    <Button
      type="button"
      disabled={loading}
      variant={actionStyle.variant}
      size={actionStyle.iconOnly ? "icon" : "default"}
      className={cn(
        actionStyle.tone === "primary" &&
          "bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500",
        actionStyle.tone === "info" &&
          "border-blue-500/40 bg-blue-500/10 text-blue-700 hover:bg-blue-500/20 dark:text-blue-300"
      )}
      onClick={onClick}
      aria-label={actionStyle.iconOnly ? action : undefined}
    >
      {loading || !isSendToDevAgent ? (
        <Icon className={cn(loading && "animate-spin")} />
      ) : null}
      {!actionStyle.iconOnly && (label ?? action)}
      {isSendToDevAgent && !loading ? (
        <>
          <Kbd
            data-icon="inline-end"
            className="translate-x-0.5 border-white/20 bg-white/15 text-white shadow-none"
          >
            ⌘
          </Kbd>
          <Kbd
            data-icon="inline-end"
            className="translate-x-0.5 border-white/20 bg-white/15 text-white shadow-none"
          >
            ⏎
          </Kbd>
        </>
      ) : null}
    </Button>
  )
}
