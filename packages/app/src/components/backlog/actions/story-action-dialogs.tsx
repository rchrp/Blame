import * as React from "react"
import {
  CircleStopIcon,
  MessageSquareReplyIcon,
  PauseIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import type { OpenDrawer } from "@/components/backlog/shared/backlog-types"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export type StopAgentChoice = "pause-feedback" | "backlog" | "discard-worktree"
export type RejectChoice = "request-changes" | "discard"

export function DeleteUserStoryDialog({
  onDeleteUserStory,
  story,
  triggerClassName,
  triggerIconOnly,
  triggerSize = "sm",
}: {
  onDeleteUserStory: (story: UserStory) => Promise<void>
  story: UserStory
  triggerClassName?: string
  triggerIconOnly?: boolean
  triggerSize?: React.ComponentProps<typeof Button>["size"]
}) {
  const [open, setOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          size={triggerSize}
          variant="destructive"
          className={cn(
            triggerIconOnly ? "justify-center" : "justify-start",
            triggerClassName
          )}
          aria-label={triggerIconOnly ? "Delete Permanently" : undefined}
        >
          <Trash2Icon />
          {!triggerIconOnly && "Delete Permanently"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>Delete User Story</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete this user story from the database.
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleting}
            variant="destructive"
            onClick={(event) => {
              event.preventDefault()
              void deleteStory()
            }}
          >
            Delete Permanently
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  async function deleteStory() {
    if (deleting) return
    setDeleting(true)
    try {
      await onDeleteUserStory(story)
      setOpen(false)
    } catch (error) {
      toast.error("Unable to delete user story", {
        description:
          error instanceof Error ? error.message : "An unexpected error occurred.",
        position: "bottom-right",
      })
    } finally {
      setDeleting(false)
    }
  }
}

export function StopAgentDialog({
  onOpenDrawer,
  onStopAgent,
  story,
  triggerSize = "sm",
}: {
  onOpenDrawer: OpenDrawer
  onStopAgent: (story: UserStory, choice: StopAgentChoice) => Promise<UserStory>
  story: UserStory
  triggerSize?: React.ComponentProps<typeof Button>["size"]
}) {
  const [stopping, setStopping] = React.useState<StopAgentChoice>()

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          size={triggerSize}
          variant="destructive"
          className="justify-start"
        >
          <CircleStopIcon />
          Stop Agent
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stop Agent</DialogTitle>
          <DialogDescription>
            Choose how this in-progress user story should continue.
            {story.workspaceMode === "direct"
              ? " It runs directly in your project folder: the files it changed stay there."
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <StopChoice
            icon={PauseIcon}
            label="Pause & Give Feedback"
            loading={stopping === "pause-feedback"}
            onClick={() => {
              void stop("pause-feedback").then((nextStory) => {
                if (!nextStory) return
                onOpenDrawer({
                  userStory: nextStory,
                  mode: "view",
                  initialTab: "user-story",
                  focusComment: true,
                })
              })
            }}
          />
          <StopChoice
            icon={RotateCcwIcon}
            label="Stop & Send Back to Backlog"
            loading={stopping === "backlog"}
            onClick={() => {
              void stop("backlog")
            }}
          />
          <Separator />
          <StopChoice
            icon={Trash2Icon}
            label={
              story.workspaceMode === "direct" ? "Stop & Discard Story" : "Discard Worktree"
            }
            destructive
            loading={stopping === "discard-worktree"}
            onClick={() => {
              void stop("discard-worktree")
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )

  async function stop(choice: StopAgentChoice) {
    if (stopping) return
    setStopping(choice)
    try {
      return await onStopAgent(story, choice)
    } finally {
      setStopping(undefined)
    }
  }
}

export function RejectDialog({
  onOpenDrawer,
  onReject,
  story,
  triggerClassName,
  triggerSize = "sm",
}: {
  onOpenDrawer: OpenDrawer
  onReject: (story: UserStory, choice: RejectChoice) => Promise<UserStory>
  story: UserStory
  triggerClassName?: string
  triggerSize?: React.ComponentProps<typeof Button>["size"]
}) {
  const [rejecting, setRejecting] = React.useState<RejectChoice>()

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          size={triggerSize}
          variant="destructive"
          className={cn("w-full justify-start", triggerClassName)}
        >
          <XIcon />
          Reject
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject User Story</DialogTitle>
          <DialogDescription>
            Choose whether the agent should continue or the user story should be
            discarded.
            {story.workspaceMode === "direct"
              ? " Discarding keeps the files the agent changed in your project folder."
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <StopChoice
            icon={MessageSquareReplyIcon}
            label="Request Changes"
            loading={rejecting === "request-changes"}
            onClick={() => {
              void reject("request-changes").then((nextStory) => {
                if (!nextStory) return
                onOpenDrawer({
                  userStory: nextStory,
                  mode: "view",
                  initialTab: "user-story",
                  focusComment: true,
                })
              })
            }}
          />
          <StopChoice
            icon={Trash2Icon}
            label="Discard User Story"
            destructive
            loading={rejecting === "discard"}
            onClick={() => {
              void reject("discard")
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )

  async function reject(choice: RejectChoice) {
    if (rejecting) return
    setRejecting(choice)
    try {
      return await onReject(story, choice)
    } finally {
      setRejecting(undefined)
    }
  }
}

function StopChoice({
  icon: Icon,
  label,
  loading,
  onClick,
  destructive,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  loading?: boolean
  onClick?: () => void
  destructive?: boolean
}) {
  return (
    <DialogClose asChild>
      <Button
        type="button"
        disabled={loading}
        variant={destructive ? "destructive" : "outline"}
        className="justify-start"
        onClick={onClick}
      >
        <Icon />
        {label}
      </Button>
    </DialogClose>
  )
}
