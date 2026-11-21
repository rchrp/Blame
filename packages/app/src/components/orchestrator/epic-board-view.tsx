import * as React from "react"
import {
  CircleAlertIcon,
  GitMergeIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  PauseIcon,
  XIcon,
} from "lucide-react"

import { userStoryDisplayId } from "@/components/backlog/data/backlog-data"
import type {
  EpicBoardEntry,
  EpicBoardGroup,
  EpicBoardGroupId,
  EpicBoardStory,
} from "@/components/orchestrator/data/epic-board"
import { modelIntentLabels } from "@/components/orchestrator/data/epic-model-range"
import type { EpicModelKey } from "@/components/orchestrator/data/epic-data"
import { ProviderIcon } from "@/components/model/model-selector"
import { cn } from "@/lib/utils"

const groupIcons: Record<EpicBoardGroupId, React.ReactNode> = {
  "needs-you": (
    <CircleAlertIcon className="text-amber-600 dark:text-amber-400" />
  ),
  working: (
    <LoaderCircleIcon className="text-emerald-600 dark:text-emerald-400" />
  ),
  queued: <ListTodoIcon className="text-blue-600 dark:text-blue-400" />,
  merged: <GitMergeIcon className="text-violet-600 dark:text-violet-400" />,
  rejected: <XIcon className="text-muted-foreground" />,
}

// The epic's stories, grouped by what the person owes. A card opens the
// story in the backlog's drawer, over this page.
export function EpicBoardView({
  groups,
  modelName,
  onOpenStory,
}: {
  groups: EpicBoardGroup[]
  modelName: (key: EpicModelKey) => string
  onOpenStory: (storyId: string) => void
}) {
  const shown = groups.filter((group) => group.entries.length)
  if (!shown.length) {
    return (
      <div className="grid h-full place-items-center px-6 py-12 text-center">
        <div className="grid max-w-sm gap-1.5">
          <h3 className="font-heading text-base font-semibold">
            No stories yet
          </h3>
          <p className="text-sm text-muted-foreground">
            The orchestrator writes the epic&rsquo;s user stories from your
            conversation, then starts an agent on each. They show here as they
            move.
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="grid gap-6">
      {shown.map((group) => (
        <section key={group.id} aria-label={group.title} className="grid gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium [&>svg]:size-4">
            {groupIcons[group.id]}
            {group.title}
            <span className="text-muted-foreground tabular-nums">
              {group.entries.length}
            </span>
          </h3>
          <ul className="grid gap-2 @2xl/board:grid-cols-2">
            {group.entries.map((entry) => (
              <li key={entry.story.id}>
                <EpicStoryCard
                  entry={entry}
                  modelName={modelName}
                  muted={group.id === "rejected"}
                  onOpen={onOpenStory}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function EpicStoryCard({
  entry,
  modelName,
  muted,
  onOpen,
}: {
  entry: EpicBoardEntry
  modelName: (key: EpicModelKey) => string
  muted: boolean
  onOpen: (storyId: string) => void
}) {
  const { story } = entry
  const model = storyModel(story)
  const paused =
    story.status === "in-progress" && story.agentStatus === "Paused"
  return (
    <button
      className={cn(
        "group/epic-story grid w-full gap-1.5 rounded-lg border bg-white p-3 text-left shadow-xs transition-[border-color,box-shadow] outline-none hover:border-foreground/20 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-neutral-900",
        muted && "opacity-70"
      )}
      type="button"
      onClick={() => onOpen(story.id)}
    >
      <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="shrink-0 tabular-nums">
          {userStoryDisplayId(story)}
        </span>
        {story.status === "in-progress" && !paused ? (
          <span
            aria-label="Agent working"
            className="agent-thinking-mark size-2 rounded-full"
          />
        ) : null}
        {paused ? <PauseIcon aria-label="Paused" className="size-3" /> : null}
        {story.modelIntent ? (
          <span className="ml-auto shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-foreground/80">
            {modelIntentLabels[story.modelIntent]}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "text-sm leading-snug font-medium break-words text-card-foreground transition-colors group-hover/epic-story:text-blue-600 dark:group-hover/epic-story:text-blue-300",
          muted && "line-through decoration-muted-foreground/50"
        )}
      >
        {story.title}
      </span>
      {model ? (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ProviderIcon className="shrink-0" providerId={model.providerId} />
          <span className="truncate">{modelName(model)}</span>
        </span>
      ) : null}
      {entry.note ? (
        <span
          className={cn(
            "line-clamp-2 text-xs font-medium break-words",
            entry.alert
              ? "text-amber-700 dark:text-amber-300"
              : "text-muted-foreground"
          )}
          title={entry.note}
        >
          {entry.note}
        </span>
      ) : null}
    </button>
  )
}

// The model that works on it now, else the one its first run will use.
function storyModel(story: EpicBoardStory): EpicModelKey | undefined {
  const last = story.agentModels?.at(-1)
  if (last) return { providerId: last.providerId, modelId: last.modelId }
  if (story.requestedModel)
    return {
      providerId: story.requestedModel.providerId,
      modelId: story.requestedModel.modelId,
    }
  return undefined
}
