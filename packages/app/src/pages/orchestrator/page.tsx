import * as React from "react"
import { toast } from "sonner"
import "@/components/orchestrator/orchestrator.css"

import {
  selectBacklogStory,
  selectedBacklogStoryId,
} from "@/components/backlog/data/backlog-navigation"
import type { Epic } from "@/components/orchestrator/data/epic-data"
import {
  EpicChangeNotApplied,
  useEpicStore,
} from "@/components/orchestrator/data/epic-store"
import { useEpicConversation } from "@/components/orchestrator/data/use-epic-conversation"
import { useEpicBoard } from "@/components/orchestrator/data/use-epic-board"
import { EpicConversation } from "@/components/orchestrator/epic-conversation"
import { EpicStats } from "@/components/orchestrator/epic-stats"
import { EpicSettingsDialog } from "@/components/orchestrator/epic-settings-dialog"
import { NewEpic } from "@/components/orchestrator/new-epic"
import { OpenProjectEmptyState } from "@/components/shared/open-project-empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"

export function OrchestratorPage() {
  const project = useProjects().activeProject
  const epics = useEpicStore()
  const openStory = useStoriesOpenedHere()

  return (
    <div className="@container/epic flex h-svh min-h-0 min-w-0 flex-col overflow-hidden [--chat-stats-inset:0px] md:h-[calc(100svh_-_1rem)]">
      {!project ? (
        <OpenProjectEmptyState description="Open a project to hand a goal to the orchestrator." />
      ) : epics.loading && !epics.epics.length ? (
        <div className="mx-auto grid w-full max-w-2xl gap-3 px-4 pt-[calc(var(--header-height)+2rem)]">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : epics.error && !epics.epics.length ? (
        <div
          role="alert"
          className="mx-4 mt-[calc(var(--header-height)+1rem)] rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {epics.error}
        </div>
      ) : epics.activeEpic ? (
        <EpicView
          key={epics.activeEpic.id}
          epic={epics.activeEpic}
          onOpenStory={openStory}
        />
      ) : (
        <NewEpic
          key={project.id}
          projectId={project.id}
          onCreated={(epic) => epics.setActiveId(epic.id)}
        />
      )}
    </div>
  )
}

function EpicView({
  epic,
  onOpenStory,
}: {
  epic: Epic
  onOpenStory: (storyId: string) => void
}) {
  const epics = useEpicStore()
  const platform = usePlatform()
  const chat = useEpicConversation(epic)
  const groups = useEpicBoard(epic)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [pausing, setPausing] = React.useState(false)
  // The status goes to the API, then the host acts on it. When it cannot,
  // the person is told, never shown a pause that did not take.
  async function changeStatus(status: "paused" | "active") {
    setPausing(true)
    try {
      await epics.update(epic, { status })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(
        error instanceof EpicChangeNotApplied
          ? status === "paused"
            ? "The epic is marked paused, but Blame could not pause its work"
            : "The epic is marked active, but Blame could not resume its work"
          : status === "paused"
            ? "Couldn't pause the epic"
            : "Couldn't resume the epic",
        { description: message, position: "bottom-right" }
      )
    } finally {
      setPausing(false)
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-2 pt-[calc(var(--header-height)+0.25rem)] [--conversation-top:0px] @min-[48rem]/epic:flex-row-reverse @min-[48rem]/epic:gap-0">
        <div
          aria-label="Epic statistics"
          role="region"
          className="epic-statistics mx-4 flex max-h-[32%] min-h-0 shrink-0 flex-col @min-[48rem]/epic:mr-4 @min-[48rem]/epic:mb-4 @min-[48rem]/epic:ml-0 @min-[48rem]/epic:max-h-none @min-[48rem]/epic:w-80"
        >
          <EpicStats
            epic={epic}
            chat={chat}
            groups={groups}
            pausing={pausing || !platform.engine}
            onChangeStatus={() =>
              void changeStatus(epic.status === "paused" ? "active" : "paused")
            }
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenStory={onOpenStory}
          />
        </div>
        <EpicConversation
          epic={epic}
          chat={chat}
          groups={groups}
          onOpenStory={onOpenStory}
        />
      </div>
      <EpicSettingsDialog
        epic={epic}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSave={(settings, title) =>
          epics.update(epic, { settings, title }).catch((error: unknown) => {
            // Saved: only telling the host failed, which the next look repairs.
            if (!(error instanceof EpicChangeNotApplied)) throw error
            toast.warning(
              "Saved, but Blame could not tell the orchestrator yet",
              {
                description: error.message,
                position: "bottom-right",
              }
            )
          })
        }
      />
    </>
  )
}

// A story opened from the board shows in the backlog's drawer over this
// page (the drawer only shows the selected story here). A story selected
// before the page opened is not carried over, and one opened here closes
// when the page does, instead of following the person to the backlog.
function useStoriesOpenedHere() {
  const openedHere = React.useRef<string>(undefined)
  React.useEffect(() => {
    if (selectedBacklogStoryId()) selectBacklogStory(undefined)
    return () => {
      const opened = openedHere.current
      if (opened && selectedBacklogStoryId() === opened)
        selectBacklogStory(undefined)
    }
  }, [])
  return React.useCallback((storyId: string) => {
    openedHere.current = storyId
    selectBacklogStory(storyId)
  }, [])
}
