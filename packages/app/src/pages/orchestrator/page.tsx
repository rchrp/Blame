import * as React from "react"
import { toast } from "sonner"

import {
  selectBacklogStory,
  selectedBacklogStoryId,
} from "@/components/backlog/data/backlog-navigation"
import type {
  Epic,
  EpicSettings,
} from "@/components/orchestrator/data/epic-data"
import { useEpicStore } from "@/components/orchestrator/data/epic-store"
import { useEpicBoard } from "@/components/orchestrator/data/use-epic-board"
import { useEpicModels } from "@/components/orchestrator/data/use-epic-models"
import { EpicBoardView } from "@/components/orchestrator/epic-board-view"
import { EpicConversation } from "@/components/orchestrator/epic-conversation"
import { EpicHeader } from "@/components/orchestrator/epic-header"
import { EpicSettingsDialog } from "@/components/orchestrator/epic-settings-dialog"
import { NewEpic } from "@/components/orchestrator/new-epic"
import { OpenProjectEmptyState } from "@/components/shared/open-project-empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { cn } from "@/lib/utils"

export function OrchestratorPage() {
  const project = useProjects().activeProject
  const epics = useEpicStore()
  const openStory = useStoriesOpenedHere()

  return (
    <div className="@container/epic flex h-svh min-h-0 min-w-0 flex-col gap-4 overflow-hidden px-4 pt-[calc(var(--header-height)+1rem)] pb-4 md:h-[calc(100svh_-_1rem)] lg:px-6 lg:pt-[calc(var(--header-height)+1.5rem)] lg:pb-6">
      {!project ? (
        <OpenProjectEmptyState description="Open a project to hand a goal to the orchestrator." />
      ) : epics.loading && !epics.epics.length ? (
        <div className="mx-auto grid w-full max-w-2xl gap-3 py-10">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : epics.error && !epics.epics.length ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {epics.error}
        </div>
      ) : epics.activeEpic ? (
        <EpicView
          key={epics.activeEpic.id}
          epic={epics.activeEpic}
          onOpenStory={openStory}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NewEpic
            firstEpic={!epics.epics.length}
            onCreated={(epic) => epics.setActiveId(epic.id)}
          />
        </div>
      )}
    </div>
  )
}

type Pane = "conversation" | "board"

function EpicView({
  epic,
  onOpenStory,
}: {
  epic: Epic
  onOpenStory: (storyId: string) => void
}) {
  const epics = useEpicStore()
  const platform = usePlatform()
  const models = useEpicModels()
  const groups = useEpicBoard(epic)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [pausing, setPausing] = React.useState(false)
  // A narrow window shows one pane at a time.
  const [pane, setPane] = React.useState<Pane>("conversation")
  const needsYou =
    groups.find((group) => group.id === "needs-you")?.entries.length ?? 0

  // The host pauses the epic's running agents and the orchestrator's turn,
  // and resumes exactly those (the store tells it: epicChanged). A pause is
  // never the person's Stop (interrupt), which is not resumed.
  async function pauseAll() {
    setPausing(true)
    try {
      await epics.update(epic, { status: "paused" })
    } catch (error) {
      toast.error("Couldn't pause the epic", {
        description: error instanceof Error ? error.message : String(error),
        position: "bottom-right",
      })
    } finally {
      setPausing(false)
    }
  }

  async function resume() {
    setPausing(true)
    try {
      await epics.update(epic, { status: "active" })
    } catch (error) {
      toast.error("Couldn't resume the epic", {
        description: error instanceof Error ? error.message : String(error),
        position: "bottom-right",
      })
    } finally {
      setPausing(false)
    }
  }

  return (
    <>
      <EpicHeader
        epic={epic}
        state={epics.states.get(epic.id)}
        pausing={pausing || !platform.engine}
        onOpenSettings={() => setSettingsOpen(true)}
        onPauseAll={() => void pauseAll()}
        onRename={(title) =>
          epics.update(epic, { title }).catch((error: unknown) => {
            toast.error("Couldn't rename the epic", {
              description:
                error instanceof Error ? error.message : String(error),
              position: "bottom-right",
            })
          })
        }
        onResume={() => void resume()}
      />
      <div
        aria-label="Show"
        className="inline-flex w-fit shrink-0 rounded-lg bg-muted p-0.5 @4xl/epic:hidden"
        role="tablist"
      >
        {(["conversation", "board"] as const).map((item) => (
          <button
            key={item}
            aria-selected={pane === item}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              pane === item && "bg-background text-foreground shadow-xs"
            )}
            role="tab"
            type="button"
            onClick={() => setPane(item)}
          >
            {item === "conversation" ? "Conversation" : "Stories"}
            {item === "board" && needsYou ? (
              <span
                aria-label={`${needsYou} need you`}
                className="rounded-full bg-amber-500/15 px-1.5 text-xs text-amber-700 tabular-nums dark:text-amber-300"
              >
                {needsYou}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 gap-4 @4xl/epic:grid-cols-[minmax(22rem,2fr)_3fr]">
        <section
          aria-label="Conversation with the orchestrator"
          className={cn(
            "min-h-0 flex-col rounded-xl border bg-card/60 p-3",
            pane === "conversation" ? "flex" : "hidden @4xl/epic:flex"
          )}
        >
          <EpicConversation epic={epic} onOpenStory={onOpenStory} />
        </section>
        <section
          aria-label="The epic's stories"
          className={cn(
            "@container/board min-h-0 overflow-y-auto overscroll-contain pr-1",
            pane === "board" ? "block" : "hidden @4xl/epic:block"
          )}
        >
          <EpicBoardView
            groups={groups}
            modelName={models.modelName}
            onOpenStory={onOpenStory}
          />
        </section>
      </div>
      <EpicSettingsDialog
        epic={epic}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSave={(settings: EpicSettings) => epics.update(epic, { settings })}
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
