import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlusIcon,
} from "lucide-react"

import { useEpicStore } from "./data/epic-store"
import { useEpicActivities } from "./data/use-epic-board"
import { epicActivityLabels } from "./data/epic-board"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"

const activityIcons = {
  "needs-you": <CircleHelpIcon />,
  done: <CircleCheckIcon />,
  working: <LoaderCircleIcon />,
  paused: <PauseIcon />,
}

export function EpicSwitcher() {
  const epics = useEpicStore()
  const activities = useEpicActivities(epics.epics)
  const listed = epics.epics.filter((epic) => epic.status !== "discarded")
  const current = epics.activeEpic
  const activity = current && activities.get(current.id)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="-ml-2 max-w-full gap-2 px-2 text-base font-medium"
          aria-label={`Switch epic, ${current?.title ?? "New epic"}`}
        >
          <span className="truncate">{current?.title ?? "New epic"}</span>
          {activity && (
            <span
              role="img"
              aria-label={epicActivityLabels[activity]}
              title={epicActivityLabels[activity]}
              className="inline-flex text-muted-foreground [&>svg]:size-3.5"
            >
              {activityIcons[activity]}
            </span>
          )}
          <ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)]"
      >
        <DropdownMenuItem
          onSelect={() => epics.setActiveId(undefined)}
          className="gap-2 px-2.5 py-2"
        >
          <PlusIcon /> New epic
        </DropdownMenuItem>
        {listed.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={current?.id ?? ""}
              onValueChange={epics.setActiveId}
              aria-label="Epic history"
            >
              {listed.map((epic) => {
                const state = activities.get(epic.id)
                return (
                  <DropdownMenuRadioItem
                    value={epic.id}
                    key={epic.id}
                    textValue={epic.title}
                    className="gap-2 py-2 pl-2.5"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {epic.title}
                    </span>
                    {state && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {epicActivityLabels[state]}
                      </span>
                    )}
                  </DropdownMenuRadioItem>
                )
              })}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
