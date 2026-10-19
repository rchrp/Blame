import { GripVerticalIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react"
import { motion } from "motion/react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import { userStoryDisplayId } from "@/components/backlog/data/backlog-data"
import { CountUp } from "@/components/shared/count-up"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// The status window has no system title bar: this header is its handle.
// Drag it anywhere but the buttons to move the window.
export function StatusPipHeader({
  compact,
  count,
  onClose,
  onToggleCompact,
  status,
}: {
  compact: boolean
  count: number
  onClose?: () => void
  onToggleCompact?: () => void
  // Shown only when it says more than the count (signed out, no project…).
  status?: string
}) {
  return (
    <motion.header
      layout="position"
      data-compact-window-drag
      className={cn(
        "flex shrink-0 cursor-grab items-center gap-2 border-b bg-muted/40 select-none active:cursor-grabbing",
        compact ? "h-10 pr-1.5 pl-1.5" : "h-12 pr-2 pl-2"
      )}
    >
      <GripVerticalIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground/60"
      />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h1 className="truncate text-sm font-semibold">Active stories</h1>
        {!compact && status ? (
          <span className="truncate text-xs text-muted-foreground">{status}</span>
        ) : null}
      </div>
      <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium tabular-nums">
        <CountUp value={count} />
      </span>
      {onToggleCompact ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="size-7 text-muted-foreground"
          aria-label={compact ? "Show full cards" : "Compact view"}
          title={compact ? "Show full cards (C)" : "Compact view (C)"}
          onClick={onToggleCompact}
        >
          {compact ? <Maximize2Icon /> : <Minimize2Icon />}
        </Button>
      ) : null}
      {onClose ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label="Close"
          title="Close (Esc)"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      ) : null}
    </motion.header>
  )
}

// One line per story: what it is and where it stands.
export function StatusPipCompactRow({
  index,
  onOpen,
  story,
}: {
  index: number
  onOpen(story: UserStory): void
  story: UserStory
}) {
  const review = story.status === "in-review"
  const paused = story.agentStatus === "Paused"
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0, transition: { delay: index * 0.03 } }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
    >
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors hover:bg-foreground/8 focus-visible:bg-foreground/8 focus-visible:outline-none"
        onClick={() => onOpen(story)}
      >
        <span className="relative flex size-2 shrink-0">
          {!review && !paused ? (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-500/60 motion-reduce:hidden" />
          ) : null}
          <span
            className={cn(
              "relative inline-flex size-2 rounded-full",
              review ? "bg-violet-500" : paused ? "bg-muted-foreground" : "bg-amber-500"
            )}
          />
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {userStoryDisplayId(story)}
        </span>
        <span className="min-w-0 flex-1 truncate">{story.title}</span>
        <span
          className={cn(
            "shrink-0 text-[11px] font-medium",
            review ? "text-violet-600 dark:text-violet-300" : "text-muted-foreground"
          )}
        >
          {review ? "Review" : paused ? "Paused" : "Working"}
        </span>
      </button>
    </motion.li>
  )
}
