import { PictureInPicture2Icon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

export function BacklogToolbar({
  disabled,
  onOpenStatusPip,
  onCreateUserStory,
  storyCount,
}: {
  disabled?: boolean
  onOpenStatusPip?: () => void
  onCreateUserStory: () => void
  storyCount: number
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="project-page-title">Backlog</h2>
        <p className="text-sm text-muted-foreground">
          {storyCount} {storyCount === 1 ? "user story" : "user stories"} across
          the delivery pipeline
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onOpenStatusPip && (
          <Button
            type="button"
            variant="ghost"
            className="text-muted-foreground"
            disabled={disabled}
            onClick={onOpenStatusPip}
          >
            <PictureInPicture2Icon />
            Picture in Picture
          </Button>
        )}
        <Button type="button" disabled={disabled} onClick={onCreateUserStory}>
          <PlusIcon />
          New User Story
        </Button>
      </div>
    </div>
  )
}
