import type * as React from "react"
import { PictureInPicture2Icon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

export function BacklogToolbar({
  disabled,
  onOpenStatusPip,
  onCreateUserStory,
  planAction,
  storyCount,
}: {
  disabled?: boolean
  onOpenStatusPip?: () => void
  onCreateUserStory: () => void
  // Plan mode's button, when the agent can plan stories here.
  planAction?: React.ReactNode
  storyCount: number
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="font-heading text-xl font-semibold tracking-normal">
          Backlog
        </h2>
        <p className="text-sm text-muted-foreground">
          {storyCount} user stories across the delivery pipeline
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onOpenStatusPip && (
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={onOpenStatusPip}
          >
            <PictureInPicture2Icon />
            Status PiP
          </Button>
        )}
        {planAction}
        <Button type="button" disabled={disabled} onClick={onCreateUserStory}>
          <PlusIcon />
          New User Story
        </Button>
      </div>
    </div>
  )
}
