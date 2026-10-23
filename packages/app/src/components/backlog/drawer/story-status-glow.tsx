import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import type { BacklogColumnId } from "@/components/backlog/data/backlog-data"

// When the story moves to another status, the drawer's edge lights up from
// its top left corner in that status's color (the sub-agent response
// border): it bursts out along the edges, holds a moment and pulls back.
// Nothing on the first render.

const statusColors: Record<
  BacklogColumnId,
  { color: string; glowColor: string }
> = {
  backlog: {
    color: "oklch(0.78 0.02 260)",
    glowColor: "oklch(0.72 0.02 260 / 24%)",
  },
  ready: {
    color: "oklch(0.72 0.16 250)",
    glowColor: "oklch(0.66 0.18 250 / 28%)",
  },
  "in-progress": {
    color: "oklch(0.76 0.17 160)",
    glowColor: "oklch(0.7 0.17 160 / 28%)",
  },
  "in-review": {
    color: "oklch(0.72 0.2 295)",
    glowColor: "oklch(0.67 0.22 295 / 28%)",
  },
  done: {
    color: "oklch(0.78 0.17 55)",
    glowColor: "oklch(0.72 0.19 55 / 28%)",
  },
  discarded: {
    color: "oklch(0.72 0.2 15)",
    glowColor: "oklch(0.66 0.22 15 / 28%)",
  },
}

export function StoryStatusGlow({ status }: { status: BacklogColumnId }) {
  const reduceMotion = useReducedMotion()
  const [seenStatus, setSeenStatus] = React.useState(status)
  const [glow, setGlow] = React.useState<{
    id: number
    status: BacklogColumnId
  }>()
  if (seenStatus !== status) {
    setSeenStatus(status)
    setGlow({ id: (glow?.id ?? 0) + 1, status })
  }
  if (reduceMotion) return null
  const colors = glow ? statusColors[glow.status] : undefined
  return (
    <AnimatePresence>
      {glow && colors ? (
        <motion.div
          key={glow.id}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[45] rounded-[inherit]"
          style={
            {
              "--story-status-color": colors.color,
              "--story-status-glow-color": colors.glowColor,
            } as React.CSSProperties
          }
          initial={{ opacity: 0, "--corner-w": "6%", "--corner-h": "10%" }}
          animate={{
            opacity: [0, 1, 1, 0],
            "--corner-w": ["6%", "62%", "48%", "30%"],
            "--corner-h": ["10%", "115%", "88%", "50%"],
          }}
          transition={{
            duration: 2.6,
            times: [0, 0.16, 0.32, 1],
            ease: ["easeOut", "easeInOut", "easeIn"],
          }}
          onAnimationComplete={() =>
            setGlow((current) =>
              current?.id === glow.id ? undefined : current
            )
          }
        >
          <div className="story-status-corner story-status-corner-glow" />
          <div className="story-status-corner" />
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
