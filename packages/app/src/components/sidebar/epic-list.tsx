import * as React from "react"
import { PlusIcon } from "lucide-react"

import {
  epicActivityLabels,
  type EpicActivity,
} from "@/components/orchestrator/data/epic-board"
import { useEpicStore } from "@/components/orchestrator/data/epic-store"
import { useEpicActivities } from "@/components/orchestrator/data/use-epic-board"
import { navigate } from "@/components/navigation/navigation"
import { AppLink } from "@/components/navigation/app-link"
import { SidebarListSkeleton } from "@/components/shared/skeletons"
import {
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

const initialEpicCount = 5
const epicPageStep = 5

export const newEpicEvent = "blame:new-epic"

/** Opens the orchestrator's page on its new epic form. */
export function startNewEpic(epics: ReturnType<typeof useEpicStore>) {
  epics.setActiveId(undefined)
  navigate("/orchestrator")
  window.dispatchEvent(new Event(newEpicEvent))
}

// The project's epics under the Orchestrator entry, the way quick chats sit
// under Chat: a dot for what each owes, then New epic.
export function EpicList({ pathname }: { pathname: string }) {
  const epics = useEpicStore()
  const activities = useEpicActivities(epics.epics)
  const [pagination, setPagination] = React.useState({
    count: initialEpicCount,
    projectId: epics.projectId,
  })
  const visibleCount =
    pagination.projectId === epics.projectId
      ? pagination.count
      : initialEpicCount
  const visibleEpics = epics.epics
    .filter((epic) => epic.status !== "discarded")
    .slice(0, visibleCount)
  const shownCount = epics.epics.filter(
    (epic) => epic.status !== "discarded"
  ).length

  function setVisibleCount(update: (current: number) => number) {
    setPagination({ count: update(visibleCount), projectId: epics.projectId })
  }

  if (!epics.projectId) return null

  return (
    <SidebarMenuSub className="gap-0.5 pb-1">
      {epics.loading && !epics.epics.length ? (
        <SidebarMenuSubItem>
          <SidebarListSkeleton rows={2} />
        </SidebarMenuSubItem>
      ) : null}
      {visibleEpics.map((epic) => {
        const activity = activities.get(epic.id)
        return (
          <SidebarMenuSubItem key={epic.id}>
            <SidebarMenuButton
              asChild
              className="h-8 pr-7 pl-2 text-sm"
              isActive={
                pathname === "/orchestrator" && epics.activeId === epic.id
              }
              tooltip={epic.title}
            >
              <AppLink
                href="/orchestrator"
                onClick={() => epics.setActiveId(epic.id)}
              >
                <span className="truncate">{epic.title}</span>
                {activity ? <EpicDot activity={activity} /> : null}
              </AppLink>
            </SidebarMenuButton>
          </SidebarMenuSubItem>
        )
      })}
      <SidebarMenuSubItem>
        <button
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring [&>svg]:size-4"
          type="button"
          onClick={() => startNewEpic(epics)}
        >
          <PlusIcon />
          New epic
        </button>
      </SidebarMenuSubItem>
      {shownCount > initialEpicCount ? (
        <SidebarMenuSubItem className="flex items-center gap-1 px-1 pt-1">
          {visibleCount < shownCount ? (
            <button
              className="rounded px-1.5 py-1 text-[11px] font-medium text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              onClick={() =>
                setVisibleCount((current) =>
                  Math.min(current + epicPageStep, shownCount)
                )
              }
              type="button"
            >
              Show more
            </button>
          ) : null}
          {visibleCount > initialEpicCount ? (
            <button
              className="rounded px-1.5 py-1 text-[11px] font-medium text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              onClick={() =>
                setVisibleCount((current) =>
                  Math.max(initialEpicCount, current - epicPageStep)
                )
              }
              type="button"
            >
              Show less
            </button>
          ) : null}
        </SidebarMenuSubItem>
      ) : null}
    </SidebarMenuSub>
  )
}

function EpicDot({ activity }: { activity: EpicActivity }) {
  const label = epicActivityLabels[activity]
  return (
    <span
      aria-label={label}
      className="absolute right-2.5 flex size-2.5 items-center justify-center"
      role="img"
      title={label}
    >
      <span
        className={cn(
          "rounded-full",
          activity === "working" && "agent-thinking-mark size-2!",
          activity === "needs-you" && "size-2 bg-amber-500",
          activity === "done" && "size-2 bg-emerald-500",
          activity === "paused" && "size-2 border border-muted-foreground/60"
        )}
      />
    </span>
  )
}
