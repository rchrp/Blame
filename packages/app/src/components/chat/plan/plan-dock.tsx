import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  ChevronUpIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleMinusIcon,
} from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { isBoolean, useUiMemory } from "@/lib/ui-memory"

import {
  planAnnouncement,
  planCount,
  statusWords,
  type PlanDockModel,
  type PlanRow,
} from "./plan-model.ts"

// The agent's plan, pinned above the composer. Collapsed it is one pill: the
// count and the step in hand. Opened, the list grows upward from the pill, so
// the pill never moves under the pointer. A finished plan folds to a line.

export function PlanDock({
  className,
  model,
  onHeightChange,
}: {
  className?: string
  model: PlanDockModel | undefined
  /** The dock's height, for a view that keeps its messages clear of it. */
  onHeightChange?: (height: number) => void
}) {
  const reduceMotion = useReducedMotion() ?? false
  return (
    <AnimatePresence initial={false}>
      {model ? (
        <motion.div
          key="plan-dock"
          animate={{ height: "auto", opacity: 1 }}
          className={cn("-mx-1 overflow-hidden px-1", className)}
          exit={{ height: 0, opacity: 0 }}
          initial={{ height: 0, opacity: 0 }}
          transition={{
            duration: reduceMotion ? 0 : 0.22,
            ease: [0.16, 1, 0.3, 1],
          }}
        >
          <Dock model={model} onHeightChange={onHeightChange} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

function Dock({
  model,
  onHeightChange,
}: {
  model: PlanDockModel
  onHeightChange?: (height: number) => void
}) {
  const listId = React.useId()
  const [pinnedOpen, setPinnedOpen] = useUiMemory(
    "chat.plan-expanded",
    true,
    isBoolean
  )
  // A finished plan is a line until the person opens it, and each plan is
  // its own: opening one does not open the next.
  const [openFinished, setOpenFinished] = React.useState<string>()
  const open = model.finished ? openFinished === model.call : pinnedOpen
  const root = React.useRef<HTMLDivElement>(null)
  const list = React.useRef<HTMLOListElement>(null)
  const current = React.useRef<HTMLLIElement>(null)
  const currentNumber = model.current?.number

  function toggle() {
    if (model.finished) setOpenFinished(open ? undefined : model.call)
    else setPinnedOpen(!open)
  }

  // The step in hand stays in sight in a list that scrolls.
  React.useEffect(() => {
    const scroller = list.current
    const row = current.current
    if (!open || !scroller || !row) return
    const margin = 8
    if (row.offsetTop < scroller.scrollTop)
      scroller.scrollTop = Math.max(0, row.offsetTop - margin)
    else if (
      row.offsetTop + row.offsetHeight >
      scroller.scrollTop + scroller.clientHeight
    )
      scroller.scrollTop =
        row.offsetTop + row.offsetHeight - scroller.clientHeight + margin
  }, [open, currentNumber])

  React.useLayoutEffect(() => {
    const element = root.current
    if (!element || !onHeightChange) return
    const report = () =>
      onHeightChange(Math.ceil(element.getBoundingClientRect().height))
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => {
      observer.disconnect()
      onHeightChange(0)
    }
  }, [onHeightChange])

  const label = model.finished
    ? model.abandoned
      ? `Plan complete · ${model.abandoned} abandoned`
      : "Plan complete"
    : (model.current?.step ?? "")

  return (
    <section
      ref={root}
      aria-label="Agent plan"
      className="grid gap-1.5 py-1"
      data-slot="plan-dock"
    >
      {/* Said when the count or the step in hand changes, not while text streams. */}
      <span className="sr-only" role="status">
        {planAnnouncement(model)}
      </span>
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        )}
        id={listId}
        inert={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <ol
            ref={list}
            aria-label="Steps"
            className="relative max-h-56 max-w-lg overflow-y-auto overscroll-contain rounded-xl border border-foreground/15 bg-muted/50 py-1.5 backdrop-blur-sm"
          >
            {model.rows.map((row) => (
              <StepRow
                key={row.number}
                innerRef={row.number === currentNumber ? current : undefined}
                row={row}
                working={model.working}
              />
            ))}
          </ol>
        </div>
      </div>
      <button
        aria-controls={listId}
        aria-expanded={open}
        className="inline-flex h-8 max-w-[min(26rem,calc(100%-11rem))] min-w-40 items-center gap-2 justify-self-start rounded-lg border border-foreground/15 bg-muted/50 pr-2 pl-2.5 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
        onClick={toggle}
        type="button"
      >
        <span className="grid size-4 shrink-0 place-items-center">
          {model.finished ? (
            <CircleCheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <span
              aria-hidden
              className="plan-step-mark"
              data-working={model.working}
            />
          )}
        </span>
        <span className="font-medium text-foreground tabular-nums">
          {planCount(model)}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
          {label}
        </span>
        <ChevronUpIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-180"
          )}
        />
      </button>
    </section>
  )
}

function StepRow({
  innerRef,
  row,
  working,
}: {
  innerRef?: React.Ref<HTMLLIElement>
  row: PlanRow
  working: boolean
}) {
  const text = (
    <span
      className={cn(
        "min-w-0 text-[13px] leading-5 transition-colors duration-200 motion-reduce:transition-none",
        row.status === "completed" && "text-muted-foreground",
        row.status === "in_progress" && "font-medium text-foreground",
        row.status === "pending" && "text-foreground/80",
        row.status === "abandoned" && "text-muted-foreground line-through"
      )}
    >
      {row.step}
    </span>
  )
  return (
    <li
      ref={innerRef}
      aria-current={row.status === "in_progress" ? "step" : undefined}
      className="flex items-start gap-2.5 px-3 py-1"
    >
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
        <StepMark status={row.status} working={working} />
      </span>
      {row.status === "abandoned" && row.reason ? (
        // The reason is on hover and on focus; a screen reader gets it as text.
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="min-w-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              tabIndex={0}
            >
              {text}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{row.reason}</TooltipContent>
        </Tooltip>
      ) : (
        text
      )}
      <span className="sr-only">{statusWords(row)}</span>
    </li>
  )
}

function StepMark({
  status,
  working,
}: {
  status: PlanRow["status"]
  working: boolean
}) {
  switch (status) {
    case "completed":
      return (
        <CircleCheckIcon aria-hidden className="size-4 text-muted-foreground/70" />
      )
    case "abandoned":
      return (
        <CircleMinusIcon aria-hidden className="size-4 text-muted-foreground/60" />
      )
    case "in_progress":
      return <span aria-hidden className="plan-step-mark" data-working={working} />
    default:
      return (
        <CircleIcon aria-hidden className="size-4 text-muted-foreground/40" />
      )
  }
}
