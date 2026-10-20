import type { UserStory } from "@/components/backlog/data/backlog-data"
import { getVariantLabel, useModelDisplayName } from "@/components/model/model-selection"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

// The model (and reasoning) a story's agent runs on, next to its run mode.
export function StoryModelChip({ story }: { story: UserStory }) {
  const name = useModelDisplayName(story.agentProviderId, story.agentModelId)
  if (!name) return null
  const reasoning = [...(story.agentRuns ?? [])]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .findLast((run) => run.modelId === story.agentModelId)?.reasoningEffort
  const label = reasoning ? `${name} · ${getVariantLabel(reasoning)}` : name
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="min-w-0 truncate rounded-full bg-foreground/6 px-1.5 py-px text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        Model{reasoning ? " and reasoning" : ""} of the latest turn
      </TooltipContent>
    </Tooltip>
  )
}
