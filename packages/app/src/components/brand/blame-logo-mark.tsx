import * as React from "react"
import { motion, useReducedMotion } from "motion/react"

import { easeInOut, easeOutExpo } from "@/lib/motion"
import { cn } from "@/lib/utils"

// The Blame mark as vector paths, so the ribbon can draw itself.
// Traced from the app icon on a 512 unit grid.
const ribbonPath =
  "M122 404 V171 A60 60 0 0 1 242 171 V326 A81 81 0 0 0 404 326 A81 81 0 0 0 323 245"
const ribbonCapPath = "M86 404 A36 36 0 0 0 158 404 Z"

export function BlameLogoMark({
  animated = false,
  className,
}: {
  // Draws the ribbon on mount, then lets it breathe.
  animated?: boolean
  className?: string
}) {
  const id = React.useId().replace(/:/g, "")
  const reduceMotion = useReducedMotion()
  const draw = animated && !reduceMotion

  return (
    <svg
      viewBox="0 0 512 512"
      role="img"
      aria-label="Blame"
      className={cn("overflow-visible", className)}
    >
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6a8cff" />
          <stop offset="1" stopColor="#2343dc" />
        </linearGradient>
        <linearGradient id={`${id}-ribbon`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#c7cff6" />
        </linearGradient>
      </defs>
      <motion.g
        initial={draw ? { scale: 0.6, opacity: 0, rotate: -8 } : false}
        animate={{ scale: 1, opacity: 1, rotate: 0 }}
        transition={{ duration: 0.9, ease: easeOutExpo }}
        style={{ transformOrigin: "256px 256px" }}
      >
        <rect
          x="14"
          y="14"
          width="484"
          height="484"
          rx="112"
          fill={`url(#${id}-tile)`}
        />
      </motion.g>
      <motion.path
        d={ribbonCapPath}
        fill={`url(#${id}-ribbon)`}
        initial={draw ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.35, duration: 0.2 }}
      />
      <motion.path
        d={ribbonPath}
        fill="none"
        stroke={`url(#${id}-ribbon)`}
        strokeWidth="72"
        strokeLinecap="butt"
        initial={draw ? { pathLength: 0 } : false}
        animate={{ pathLength: 1 }}
        transition={{ delay: 0.4, duration: 1.15, ease: easeInOut }}
      />
    </svg>
  )
}
