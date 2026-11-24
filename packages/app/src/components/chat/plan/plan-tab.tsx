import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
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
  type PlanRow,
  type PlanTabModel,
} from "./plan-model.ts"

// The agent's plan, as a tab growing out of the composer's top edge on the
// left (the turn's time and diff grow out of it on the right): the editor's
// own fill and outline, with a concave curve on each side where the tab meets
// the edge. Closed it is the count and the step in hand; open, the tab grows
// upward into the list, its foot staying where it was.

const bar = 28
// The concave curves at the foot, and the rounded top corners.
const foot = 10
const corner = 11.5
// The tab is as wide as the plan's longest step asks, up to a cap: it holds
// that width while the plan holds, so nothing moves as the agent works, and it
// gives way to the turn's tab on a narrow editor.
function tabWidth(model: PlanTabModel) {
  const longest = Math.max(...model.rows.map((row) => row.step.length))
  const wanted = `min(24rem, max(17rem, calc(${Math.min(longest, 48)}ch + 7rem)))`
  return `min(${wanted}, max(10rem, calc(100% - 72px - var(--turn-tab-width, 0px) - 12px)))`
}

export function PlanTab({ model }: { model: PlanTabModel | undefined }) {
  return (
    <AnimatePresence>
      {model ? <Tab key="plan" model={model} /> : null}
    </AnimatePresence>
  )
}

function Tab({ model }: { model: PlanTabModel }) {
  const listId = React.useId()
  const tab = React.useRef<HTMLDivElement>(null)
  const list = React.useRef<HTMLOListElement>(null)
  const current = React.useRef<HTMLLIElement>(null)
  const [size, setSize] = React.useState({ height: bar, width: 0 })
  const [pinnedOpen, setPinnedOpen] = useUiMemory(
    "chat.plan-expanded",
    false,
    isBoolean
  )
  // A finished plan folds to its line, and each plan is its own: opening
  // one does not open the next.
  const [openFinished, setOpenFinished] = React.useState<string>()
  const open = model.finished ? openFinished === model.call : pinnedOpen
  const currentNumber = model.current?.number
  const toggleButton = React.useRef<HTMLButtonElement>(null)

  function close() {
    if (model.finished) setOpenFinished(undefined)
    else setPinnedOpen(false)
    toggleButton.current?.focus()
  }

  function toggle() {
    if (model.finished) setOpenFinished(open ? undefined : model.call)
    else setPinnedOpen(!open)
  }

  // The size drives the outline and the gap the editor leaves in its own.
  React.useLayoutEffect(() => {
    const element = tab.current
    const parent = element?.parentElement
    if (!element || !parent) return
    const measure = () => {
      const width = element.offsetWidth
      setSize({ height: element.offsetHeight, width })
      parent.style.setProperty("--plan-tab-width", `${width}px`)
      // Where the editor's other labels may start.
      parent.style.setProperty("--plan-tab-end", `${36 + width + 12}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
      parent.style.removeProperty("--plan-tab-width")
      parent.style.removeProperty("--plan-tab-end")
    }
  }, [])

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

  // Said after the tab is there, so even the first plan is heard.
  const announcement = planAnnouncement(model)
  const [said, setSaid] = React.useState("")
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSaid(announcement), 150)
    return () => window.clearTimeout(timer)
  }, [announcement])

  const outline = tabOutline(size.width, size.height)
  const shape = `${outline} L ${size.width} ${size.height} L 0 ${size.height} Z`
  // Opened, the list says what the label would: the bar only names the plan.
  const label = model.finished
    ? "Plan complete"
    : open
      ? "Plan"
      : (model.current?.step ?? "")

  return (
    <motion.div
      ref={tab}
      animate={{ clipPath: "inset(0% -1px 0 -1px)" }}
      className="absolute bottom-full left-9 z-10"
      data-slot="plan-tab"
      exit={{ clipPath: "inset(100% -1px 0 -1px)" }}
      initial={{ clipPath: "inset(100% -1px 0 -1px)" }}
      style={{ width: tabWidth(model) }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
    >
      <svg
        aria-hidden
        className="absolute inset-0 overflow-visible"
        height={size.height}
        width={size.width}
      >
        <path className="fill-popover" d={shape} />
        <path className="fill-none stroke-foreground/12" d={outline} />
      </svg>
      <section
        aria-label="Agent plan"
        className="relative"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return
          event.stopPropagation()
          close()
        }}
        style={{ paddingInline: foot }}
      >
        {/* Said when the count or the step in hand changes, not while text streams. */}
        <span className="sr-only" role="status">
          {said}
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
              className="relative max-h-56 overflow-y-auto overscroll-contain pt-3.5 pb-1"
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
          ref={toggleButton}
          aria-controls={listId}
          aria-expanded={open}
          aria-label={`Plan. ${planAnnouncement(model)}`}
          className="flex w-full items-center gap-2 rounded-md px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset"
          onClick={toggle}
          style={{ height: bar }}
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
          <span className="font-semibold text-foreground tabular-nums">
            {planCount(model)}
          </span>
          <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
            {label}
          </span>
          {model.finished && model.abandoned ? (
            // Never squeezed out: a step dropped is what a reviewer looks for.
            <span className="shrink-0 font-medium text-amber-700 dark:text-amber-300">
              {model.abandoned} abandoned
            </span>
          ) : null}
          <ChevronUpIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
              !open && "rotate-180"
            )}
          />
        </button>
      </section>
    </motion.div>
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
      className="flex items-start gap-2.5 px-2 py-1"
    >
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
        <StepMark status={row.status} working={working} />
      </span>
      {row.status === "abandoned" && row.reason ? (
        // The reason is on hover and on focus; a screen reader gets it as text.
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="min-w-0 cursor-help rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
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
        <CircleCheckIcon aria-hidden className="size-4 text-muted-foreground" />
      )
    case "abandoned":
      return (
        <CircleMinusIcon aria-hidden className="size-4 text-muted-foreground" />
      )
    case "in_progress":
      return <span aria-hidden className="plan-step-mark" data-working={working} />
    default:
      return (
        <CircleIcon aria-hidden className="size-4 text-muted-foreground/80" />
      )
  }
}

// From the editor's edge on the left, up and over, back down to the edge on
// the right: the turn tab's outline, for a tab of any height. Strokes sit on
// half pixels to stay crisp.
function tabOutline(width: number, height: number) {
  const edge = height - 0.5
  const left = foot + 0.5
  const right = width - foot - 0.5
  return [
    `M 0 ${edge}`,
    `A ${foot + 0.5} ${foot} 0 0 0 ${left} ${edge - foot}`,
    `L ${left} ${corner + 0.5}`,
    `A ${corner} ${corner} 0 0 1 ${left + corner} 0.5`,
    `L ${right - corner} 0.5`,
    `A ${corner} ${corner} 0 0 1 ${right} ${corner + 0.5}`,
    `L ${right} ${edge - foot}`,
    `A ${foot + 0.5} ${foot} 0 0 0 ${width} ${edge}`,
  ].join(" ")
}
