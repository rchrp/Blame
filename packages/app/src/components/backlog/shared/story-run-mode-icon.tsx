import { CloudIcon, ContainerIcon, FolderGit2Icon } from "lucide-react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const modes = {
  "local-container": {
    className: "text-primary dark:text-blue-300",
    icon: ContainerIcon,
    label: "Local Container",
  },
  "vercel-compose": {
    className: "text-sky-600 dark:text-sky-300",
    icon: CloudIcon,
    label: "Cloud Preview",
  },
  direct: {
    className: "text-muted-foreground",
    icon: FolderGit2Icon,
    label: "Direct, in the project folder",
  },
} as const

// Where a story runs (or will run), as a small colored icon on its card.
export function StoryRunModeIcon({ story }: { story: UserStory }) {
  const mode = storyRunModeKey(story)
  if (!mode) return null
  const { className, icon: Icon, label } = modes[mode]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={`Runs in ${label}`}
          className={cn("inline-flex items-center", className)}
        >
          <Icon className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

function storyRunModeKey(story: UserStory) {
  if (story.workspaceMode === "cloud-mirror") return "vercel-compose"
  if (story.workspaceMode) return story.workspaceMode
  return story.runMode ?? undefined
}
