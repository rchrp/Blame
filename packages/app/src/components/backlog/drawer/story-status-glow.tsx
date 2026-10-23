import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import type { BacklogColumnId } from "@/components/backlog/data/backlog-data"

// A soft light in the drawer's top left corner when the story moves to
// another status, in that status's color: it rises, lingers a moment and
// fades, under the header's blur. Nothing on the first render.

const statusColors: Record<BacklogColumnId, string> = {
  backlog: "var(--color-zinc-400)",
  ready: "var(--color-blue-500)",
  "in-progress": "var(--color-emerald-500)",
  "in-review": "var(--color-violet-500)",
  done: "var(--color-orange-500)",
  discarded: "var(--color-rose-500)",
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
  return (
    <AnimatePresence>
      {glow ? (
        <motion.div
          key={glow.id}
          aria-hidden
          className="pointer-events-none absolute -top-48 -left-48 z-[14] size-[34rem] rounded-full"
          style={{
            background: `radial-gradient(circle, color-mix(in oklch, ${statusColors[glow.status]} 55%, transparent) 0%, transparent 62%)`,
          }}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: [0, 1, 1, 0], scale: [0.8, 1, 1, 1.04] }}
          transition={{
            duration: 3.8,
            ease: "easeInOut",
            times: [0, 0.22, 0.6, 1],
          }}
          onAnimationComplete={() =>
            setGlow((current) =>
              current?.id === glow.id ? undefined : current
            )
          }
        />
      ) : null}
    </AnimatePresence>
  )
}
