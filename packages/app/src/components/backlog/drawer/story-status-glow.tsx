import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import type { BacklogColumnId } from "@/components/backlog/data/backlog-data"

// A soft light in the drawer's top left corner when the story moves to
// another status, in that status's color: it rises, lingers a moment and
// fades, behind the drawer's content. Nothing on the first render.

const statusColors: Record<BacklogColumnId, string> = {
  backlog: "var(--color-zinc-400)",
  ready: "var(--color-blue-500)",
  "in-progress": "var(--color-emerald-500)",
  "in-review": "var(--color-violet-500)",
  done: "var(--color-orange-500)",
  discarded: "var(--color-rose-500)",
}

// A wash rather than a spot: a wide ellipse along the top edge and a
// narrower one down the left, overlapping unevenly.
function statusWash(color: string) {
  const tint = (amount: number) =>
    `color-mix(in oklch, ${color} ${amount}%, transparent)`
  return [
    `radial-gradient(ellipse 58% 26% at 14% 0%, ${tint(22)} 0%, transparent 72%)`,
    `radial-gradient(ellipse 22% 42% at 0% 12%, ${tint(16)} 0%, transparent 70%)`,
    `radial-gradient(ellipse 30% 18% at 38% 6%, ${tint(10)} 0%, transparent 75%)`,
  ].join(", ")
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
          // Behind the drawer's content, just above its background.
          className="pointer-events-none absolute inset-0 -z-10 blur-2xl"
          style={{ background: statusWash(statusColors[glow.status]) }}
          initial={{ opacity: 0, x: -32, y: -16 }}
          animate={{
            opacity: [0, 1, 1, 0],
            x: [-32, 0, 6, 10],
            y: [-16, 0, 2, 4],
          }}
          transition={{
            duration: 4.5,
            ease: "easeInOut",
            times: [0, 0.25, 0.62, 1],
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
