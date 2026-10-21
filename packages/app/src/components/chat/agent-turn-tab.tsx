import * as React from "react"
import { AnimatePresence, motion } from "motion/react"

import {
  formatAgentTurnDuration,
  type AgentTurnMetrics,
} from "@/components/chat/agent-turn-metrics"

// The turn's time and diff, as a tab growing out of the editor's top edge:
// the editor's own fill and outline, with a concave curve on each side
// where the tab meets the edge.

const height = 28
// The concave curves at the foot, and the rounded top corners.
const foot = 10
const corner = 11.5

// On the tab's parent: the editor drops its outline under the tab, whose
// width the tab sets on that parent.
export const turnTabNotchClass =
  "[&>[data-slot=markdown-editor]]:[clip-path:polygon(-60px_-60px,calc(100%-36px-var(--turn-tab-width,0px))_-60px,calc(100%-36px-var(--turn-tab-width,0px))_0,calc(100%-36px)_0,calc(100%-36px)_-60px,calc(100%+60px)_-60px,calc(100%+60px)_calc(100%+60px),-60px_calc(100%+60px))]"

export function AgentTurnTab({ metrics }: { metrics?: AgentTurnMetrics }) {
  return (
    <AnimatePresence>
      {metrics ? <TurnTab key="turn" metrics={metrics} /> : null}
    </AnimatePresence>
  )
}

function TurnTab({ metrics }: { metrics: AgentTurnMetrics }) {
  const tabRef = React.useRef<HTMLDivElement>(null)
  const labelRef = React.useRef<HTMLDivElement>(null)
  const [labelWidth, setLabelWidth] = React.useState(0)
  const width = labelWidth + foot * 2

  React.useLayoutEffect(() => {
    const label = labelRef.current
    if (!label) return
    const observer = new ResizeObserver(() => setLabelWidth(label.offsetWidth))
    observer.observe(label)
    return () => observer.disconnect()
  }, [])

  React.useLayoutEffect(() => {
    const parent = tabRef.current?.parentElement
    parent?.style.setProperty("--turn-tab-width", `${width}px`)
    return () => {
      parent?.style.removeProperty("--turn-tab-width")
    }
  }, [width])

  const duration = formatAgentTurnDuration(metrics.elapsedMs)
  const state = metrics.running ? "This turn, in progress" : "Last turn"
  const outline = tabOutline(width)
  return (
    <motion.div
      ref={tabRef}
      animate={{ clipPath: "inset(0% -1px 0 -1px)" }}
      className="absolute right-9 bottom-full z-10 flex"
      exit={{ clipPath: "inset(100% -1px 0 -1px)" }}
      initial={{ clipPath: "inset(100% -1px 0 -1px)" }}
      style={{ height }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
    >
      <svg
        aria-hidden
        className="absolute inset-0 overflow-visible"
        height={height}
        width={width}
      >
        <path
          className="fill-muted/50"
          d={`${outline} L ${width} ${height} L 0 ${height} Z`}
        />
        <path className="fill-none stroke-foreground/20" d={outline} />
      </svg>
      <div
        ref={labelRef}
        aria-label={`${state}: ${duration}, ${metrics.additions} lines added, ${metrics.deletions} lines deleted`}
        className="relative mx-2.5 flex items-center gap-1.5 px-3 font-mono text-xs leading-none font-semibold tabular-nums"
        title={`${state}: lines changed by the agent's edits in this turn`}
      >
        <span className="text-foreground">{duration}</span>
        <span className="text-emerald-500">+{metrics.additions}</span>
        <span className="text-destructive">-{metrics.deletions}</span>
      </div>
    </motion.div>
  )
}

// From the editor's edge on the left, up and over, back down to the edge on
// the right. Strokes sit on half pixels to stay crisp.
function tabOutline(width: number) {
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
