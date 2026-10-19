import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { BlameLogoMark } from "@/components/brand/blame-logo-mark"
import { easeInOut, easeOutExpo } from "@/lib/motion"

const loadingLines = [
  "Finding someone to blame…",
  "Reading the git log for clues…",
  "Interviewing the usual suspects…",
  "Rebasing reality onto main…",
  "Warming up the worktrees…",
  "It works on my machine…",
  "Resolving conflicts diplomatically…",
  "Teaching agents to say sorry…",
  "Running git blame on the universe…",
  "Assigning responsibility…",
]
const lineDuration = 1900

// Shown inside the onboarding stage while the session loads. The 3D scene
// glides in behind it; the mark draws itself, then hands over to the next
// screen through a shared layout animation.
export function LoadingScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-7 px-6 text-foreground">
      <motion.div
        layoutId="blame-logo-mark"
        className="relative size-24"
        transition={{ duration: 0.7, ease: easeOutExpo }}
      >
        <LogoGlow />
        <BlameLogoMark animated className="relative size-full" />
      </motion.div>
      <motion.span
        layoutId="blame-logo-word"
        className="font-heading text-3xl font-extrabold tracking-tight"
        initial={{ opacity: 0, y: 8, filter: "blur(6px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ delay: 0.9, duration: 0.6, ease: easeOutExpo }}
      >
        Blame
      </motion.span>
      <LoadingLine />
      <LoadingTrack />
    </div>
  )
}

// Minimal loader for small secondary windows, where the 3D stage would be
// wasted.
export function CompactLoadingScreen() {
  return (
    <main className="flex h-svh items-center justify-center bg-background">
      <BlameLogoMark animated className="size-10" />
    </main>
  )
}

function LogoGlow() {
  const reduceMotion = useReducedMotion()

  return (
    <motion.span
      aria-hidden="true"
      className="absolute -inset-10 rounded-full bg-[radial-gradient(circle,rgba(112,132,255,0.55)_0%,rgba(112,132,255,0)_68%)] blur-xl"
      initial={{ opacity: 0, scale: 0.6 }}
      animate={
        reduceMotion
          ? { opacity: 0.7, scale: 1 }
          : { opacity: [0, 0.9, 0.55, 0.9], scale: [0.6, 1.1, 0.95, 1.1] }
      }
      transition={
        reduceMotion
          ? { duration: 0 }
          : {
              duration: 4.2,
              times: [0, 0.3, 0.65, 1],
              ease: "easeInOut",
              repeat: Infinity,
              repeatType: "mirror",
            }
      }
    />
  )
}

function LoadingLine() {
  const [index, setIndex] = React.useState(() =>
    Math.floor(Math.random() * loadingLines.length)
  )

  React.useEffect(() => {
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % loadingLines.length),
      lineDuration
    )
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div
      aria-live="polite"
      className="relative h-6 w-80 overflow-hidden text-center text-sm text-foreground/65"
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={index}
          className="absolute inset-x-0"
          initial={{ opacity: 0, y: 14, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -14, filter: "blur(6px)" }}
          transition={{ duration: 0.45, ease: easeOutExpo }}
        >
          {loadingLines[index]}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}

function LoadingTrack() {
  return (
    <motion.div
      aria-hidden="true"
      className="relative h-px w-48 overflow-hidden rounded-full bg-foreground/10"
      initial={{ opacity: 0, scaleX: 0.4 }}
      animate={{ opacity: 1, scaleX: 1 }}
      transition={{ delay: 0.6, duration: 0.6, ease: easeOutExpo }}
    >
      <motion.span
        className="absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-primary to-transparent shadow-[0_0_14px_var(--primary)] motion-reduce:hidden"
        initial={{ x: "-100%" }}
        animate={{ x: "200%" }}
        transition={{ duration: 1.4, ease: easeInOut, repeat: Infinity }}
      />
    </motion.div>
  )
}
