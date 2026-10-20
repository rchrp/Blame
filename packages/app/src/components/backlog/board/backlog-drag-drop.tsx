import * as React from "react"
import { createPortal } from "react-dom"
import {
  defaultDropAnimationSideEffects,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  type DropAnimation,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import { ArrowDownToLineIcon } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"

import type {
  BacklogColumnId,
  UserStory,
} from "@/components/backlog/data/backlog-data"
import {
  type StoryDropAction,
  storyDropActions,
} from "@/components/backlog/data/story-drop-actions"
import { ReadOnlyUserStoryCard } from "@/components/backlog/board/user-story-card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { easeOutExpo } from "@/lib/motion"
import { cn } from "@/lib/utils"

// A second way to run a story's actions: drag its card onto a column. The
// columns it can go to show one drop zone per action; the others grey out.

type BacklogDrag = { actions: StoryDropAction[]; story: UserStory }

type BacklogDragState = {
  drag?: BacklogDrag
  // The last drag ended on a drop zone: the card does not fly back.
  dropped?: boolean
  overId?: string
}

const BacklogDragContext = React.createContext<BacklogDragState>({})

const cancelDropAnimation: DropAnimation = {
  duration: 260,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.35" } },
  }),
}

export function BacklogDragDrop({
  children,
  onDrop,
  reviewDiffEmpty,
}: {
  children: React.ReactNode
  onDrop(story: UserStory, action: StoryDropAction): void
  reviewDiffEmpty?: (story: UserStory) => boolean
}) {
  const sensors = useSensors(
    // A short move before dragging, so clicks on the card's buttons work.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )
  const [state, setState] = React.useState<BacklogDragState>({})
  const [confirming, setConfirming] = React.useState<{
    action: StoryDropAction
    story: UserStory
  }>()

  function handleDragStart(event: DragStartEvent) {
    const story = event.active.data.current?.story as UserStory | undefined
    if (!story) return
    setState({
      drag: {
        actions: storyDropActions(story, {
          reviewDiffEmpty: reviewDiffEmpty?.(story),
        }),
        story,
      },
    })
  }

  function handleDragOver(event: DragOverEvent) {
    const overId = event.over ? String(event.over.id) : undefined
    setState((current) =>
      current.overId === overId ? current : { ...current, overId }
    )
  }

  function handleDragEnd(event: DragEndEvent) {
    const drag = state.drag
    const action = drag?.actions.find((item) => item.id === event.over?.id)
    setState({ dropped: Boolean(action) })
    if (!drag || !action) return
    if (action.confirm) setConfirming({ action, story: drag.story })
    else onDrop(drag.story, action)
  }

  return (
    <DndContext
      collisionDetection={pointerWithin}
      onDragCancel={() => setState({})}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragStart={handleDragStart}
      sensors={sensors}
    >
      <BacklogDragContext.Provider value={state}>
        {children}
      </BacklogDragContext.Provider>
      {createPortal(
        <DragOverlay
          dropAnimation={state.dropped ? null : cancelDropAnimation}
          zIndex={60}
        >
          {state.drag ? <DraggedStory story={state.drag.story} /> : null}
        </DragOverlay>,
        document.body
      )}
      <AlertDialog
        open={Boolean(confirming)}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.action.confirm?.title}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.action.confirm?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirming) onDrop(confirming.story, confirming.action)
                setConfirming(undefined)
              }}
            >
              {confirming?.action.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DndContext>
  )
}

// The card under the pointer: lifted, slightly tilted.
function DraggedStory({ story }: { story: UserStory }) {
  return (
    <motion.div
      animate={{ rotate: -1.5, scale: 1.03 }}
      className="cursor-grabbing rounded-lg shadow-2xl shadow-black/25"
      initial={{ rotate: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 380, damping: 26 }}
    >
      <ReadOnlyUserStoryCard story={story} />
    </motion.div>
  )
}

export function DraggableStory({
  children,
  disabled,
  story,
}: {
  children: React.ReactNode
  disabled?: boolean
  story: UserStory
}) {
  const { isDragging, listeners, setNodeRef } = useDraggable({
    data: { story },
    disabled,
    id: story.id,
  })
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      // Pointer only: the card's own buttons stay the keyboard path.
      className={cn(
        "touch-none transition-opacity duration-200 select-none",
        !disabled && "cursor-grab",
        isDragging && "opacity-35"
      )}
    >
      {children}
    </div>
  )
}

// How a column reacts to the story being dragged.
export function useColumnDrag(column: BacklogColumnId) {
  const { drag, overId } = React.useContext(BacklogDragContext)
  return React.useMemo(() => {
    if (!drag) return { state: "idle" as const, actions: [], overId }
    const actions = drag.actions.filter((action) => action.column === column)
    if (actions.length) return { state: "target" as const, actions, overId }
    if (drag.story.status === column)
      return { state: "source" as const, actions, overId }
    return { state: "disabled" as const, actions, overId }
  }, [column, drag, overId])
}

export function ColumnDropZones({
  actions,
  overId,
}: {
  actions: StoryDropAction[]
  overId?: string
}) {
  return (
    <AnimatePresence>
      {actions.length ? (
        <motion.div
          key="zones"
          animate={{ opacity: 1 }}
          className="absolute inset-0 z-10 flex flex-col gap-2.5 bg-background/55 p-3 backdrop-blur-[2px]"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: easeOutExpo }}
        >
          {actions.map((action, index) => (
            <DropZone
              key={action.id}
              action={action}
              index={index}
              over={overId === action.id}
            />
          ))}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

function DropZone({
  action,
  index,
  over,
}: {
  action: StoryDropAction
  index: number
  over: boolean
}) {
  const { setNodeRef } = useDroppable({ id: action.id })
  return (
    <motion.div
      ref={setNodeRef}
      animate={{ opacity: 1, scale: over ? 1.015 : 1, y: 0 }}
      className={cn(
        "flex min-h-24 flex-1 flex-col items-center justify-center gap-2 rounded-xl border px-4 text-center transition-[background-color,border-color,box-shadow] duration-200",
        over
          ? "border-blue-500 bg-blue-500/18 shadow-[0_0_0_4px] shadow-blue-500/15"
          : "border-blue-500/30 bg-blue-500/8",
        action.confirm &&
          over &&
          "border-rose-500 bg-rose-500/15 shadow-rose-500/15"
      )}
      initial={{ opacity: 0, scale: 0.96, y: 8 }}
      transition={{
        delay: over ? 0 : index * 0.05,
        type: "spring",
        stiffness: 420,
        damping: 30,
      }}
    >
      <motion.span
        animate={{ y: over ? 2 : 0 }}
        className={cn(
          "flex size-8 items-center justify-center rounded-full",
          action.confirm && over
            ? "bg-rose-500/15 text-rose-600 dark:text-rose-300"
            : "bg-blue-500/15 text-blue-600 dark:text-blue-300"
        )}
        transition={{ type: "spring", stiffness: 500, damping: 22 }}
      >
        <ArrowDownToLineIcon className="size-4" />
      </motion.span>
      <span
        className={cn(
          "text-sm font-semibold",
          action.confirm && over
            ? "text-rose-600 dark:text-rose-300"
            : "text-blue-700 dark:text-blue-200"
        )}
      >
        {action.label}
      </span>
    </motion.div>
  )
}
