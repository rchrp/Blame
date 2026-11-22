import * as React from "react"
import {
  CircleAlertIcon,
  GitMergeIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  ChevronRightIcon,
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
  "needs-you": <CircleAlertIcon />,
  working: <LoaderCircleIcon />,
  queued: <ListTodoIcon />,
  merged: <GitMergeIcon />,
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
  const total = shown.reduce((count, group) => count + group.entries.length, 0)
  return (
    <section
      aria-label="The epic's stories"
      className="epic-stories grid min-w-0 gap-3 border-t pt-3"
    >
      <h3 className="flex items-baseline justify-between text-sm font-semibold">
        User stories{" "}
        <span className="text-xs font-normal text-muted-foreground tabular-nums">
          {total}
        </span>
      </h3>
      {!total ? (
        <p className="text-xs text-muted-foreground">
          Stories appear here as the orchestrator plans the work.
        </p>
      ) : null}
      {shown.map((group) => (
        <section
          key={group.id}
          aria-label={group.title}
          className="grid min-w-0 gap-1"
        >
          <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&>svg]:size-3.5">
            {groupIcons[group.id]} {group.title}{" "}
            <span className="tabular-nums">· {group.entries.length}</span>
          </h4>
          <ul className="grid divide-y divide-border/50">
            {group.entries.map((entry) => (
              <li key={entry.story.id}>
                <EpicStoryRow
                  entry={entry}
                  modelName={modelName}
                  onOpen={onOpenStory}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  )
}

function EpicStoryRow({
  entry,
  modelName,
  onOpen,
}: {
  entry: EpicBoardEntry
  modelName: (key: EpicModelKey) => string
  onOpen: (storyId: string) => void
}) {
  const { story } = entry
  const model = storyModel(story)
  return (
    <button
      className="group/story -mx-1 grid w-[calc(100%+0.5rem)] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1 gap-y-0.5 rounded-md px-1.5 py-2 text-left outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring"
      title={`Open ${userStoryDisplayId(story)}`}
      type="button"
      onClick={() => onOpen(story.id)}
    >
      <span className="text-sm leading-snug font-medium break-words">
        {story.title}
      </span>
      <ChevronRightIcon className="row-span-2 size-3.5 text-muted-foreground group-hover/story:text-foreground" />
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="shrink-0 tabular-nums">
          {userStoryDisplayId(story)}
        </span>
        {model && (
          <>
            <ProviderIcon
              className="size-3 shrink-0"
              providerId={model.providerId}
            />
            <span className="truncate">{modelName(model)}</span>
          </>
        )}
        {story.modelIntent && (
          <span className="ml-auto">
            {modelIntentLabels[story.modelIntent]}
          </span>
        )}
      </span>
      {entry.note && (
        <span
          className={cn(
            "col-span-2 text-xs break-words text-muted-foreground",
            entry.alert && "font-medium"
          )}
        >
          {entry.note}
        </span>
      )}
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
