import * as React from "react"
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Variants,
} from "motion/react"
import { ArrowUpRightIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { easeInOut, easeOutExpo, riseIn } from "@/lib/motion"

// How long the thank-you stays before the card leaves on its own.
const thanksMs = 2400
// The lucide star, drawn by hand so its outline can trace itself.
const starPath =
  "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"
const sparklePath =
  "M5 0C5.4 3.2 6.8 4.6 10 5 6.8 5.4 5.4 6.8 5 10 4.6 6.8 3.2 5.4 0 5 3.2 4.6 4.6 3.2 5 0Z"
// Five sparkles fanned around the star, each thrown once.
const sparkles = [-90, -18, 54, 126, 198].map((degrees, index) => ({
  x: Math.cos((degrees * Math.PI) / 180) * (index % 2 ? 17 : 21),
  y: Math.sin((degrees * Math.PI) / 180) * (index % 2 ? 17 : 21),
  size: index % 2 ? 5 : 7,
  delay: 0.82 + index * 0.03,
}))
// The star traces itself, then fills: the card's one flourish.
const drawAt = 0.18
const fillAt = 0.78

const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.3 } },
}

export function StarInviteCard({
  onClose,
  onStar,
}: {
  onClose(): void
  onStar(): void
}) {
  const reduceMotion = useReducedMotion() ?? false
  const [thanked, setThanked] = React.useState(false)
  const cardRef = React.useRef<HTMLDivElement>(null)
  const titleId = React.useId()

  React.useEffect(() => {
    if (!thanked) return
    const timer = window.setTimeout(onClose, thanksMs)
    return () => window.clearTimeout(timer)
  }, [onClose, thanked])

  // Escape closes the card, unless a dialog or a text field had it first.
  React.useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (event.isComposing) return
      const target = event.target
      const inCard = target instanceof Node && cardRef.current?.contains(target)
      if (!inCard && editable(target)) return
      onClose()
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [onClose])

  return (
    <motion.div
      ref={cardRef}
      aria-labelledby={titleId}
      data-star-invite=""
      role="group"
      variants={reduceMotion ? fadeIn : riseIn}
      initial="initial"
      animate="animate"
      className="relative w-(--width) rounded-2xl bg-popover/80 p-4 text-popover-foreground shadow-lg ring-1 ring-foreground/10 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150"
    >
      <Button
        aria-label="Close"
        className="absolute top-3 right-3 text-muted-foreground"
        onClick={onClose}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon />
      </Button>
      <div className="flex gap-3">
        <StarMark still={reduceMotion} />
        <div className="min-w-0 pt-0.5 pr-6">
          <p className="text-sm leading-5 font-medium" id={titleId}>
            {thanked ? "Thank you" : "Blame is open source"}
          </p>
          <p className="mt-0.5 text-[0.8rem] leading-5 text-muted-foreground">
            {thanked
              ? "It really helps."
              : "If it's useful to you, a star on GitHub helps other developers find it."}
          </p>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {thanked ? null : (
          <motion.div
            key="actions"
            className="overflow-hidden"
            exit={{
              height: 0,
              opacity: 0,
              transition: {
                duration: reduceMotion ? 0 : 0.28,
                ease: easeInOut,
              },
            }}
          >
            <div className="grid grid-cols-2 gap-2 pt-3.5">
              <Button
                onClick={() => {
                  onStar()
                  setThanked(true)
                }}
                size="sm"
              >
                Star on GitHub
                <ArrowUpRightIcon data-icon="inline-end" />
              </Button>
              <Button onClick={onClose} size="sm" variant="outline">
                Not now
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function StarMark({ still }: { still: boolean }) {
  const gradientId = React.useId()
  const draw = { duration: 0.62, delay: drawAt, ease: easeInOut }
  const fill = { duration: 0.36, delay: fillAt, ease: easeOutExpo }
  return (
    <div
      aria-hidden="true"
      className="relative grid size-9 shrink-0 place-items-center rounded-xl bg-amber-400/12 text-amber-500 ring-1 ring-amber-500/20 dark:bg-amber-300/10 dark:text-amber-300 dark:ring-amber-300/20"
    >
      <motion.svg
        className="size-5 overflow-visible"
        viewBox="0 0 24 24"
        initial={still ? false : { scale: 1 }}
        animate={still ? undefined : { scale: [1, 1.14, 1] }}
        transition={{ duration: 0.5, delay: fillAt, times: [0, 0.4, 1] }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#fbe1a6" />
            <stop offset="100%" stopColor="#f2b84b" />
          </linearGradient>
        </defs>
        <motion.path
          d={starPath}
          fill={`url(#${gradientId})`}
          initial={still ? false : { fillOpacity: 0 }}
          animate={{ fillOpacity: 1 }}
          transition={fill}
        />
        <motion.path
          d={starPath}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.6}
          initial={still ? false : { pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{
            pathLength: draw,
            opacity: { duration: 0.1, delay: drawAt },
          }}
        />
      </motion.svg>
      {still
        ? null
        : sparkles.map((sparkle) => (
            <motion.svg
              key={`${sparkle.x}:${sparkle.y}`}
              className="pointer-events-none absolute top-1/2 left-1/2 text-amber-400 dark:text-amber-200"
              style={{
                height: sparkle.size,
                marginLeft: -sparkle.size / 2,
                marginTop: -sparkle.size / 2,
                width: sparkle.size,
              }}
              viewBox="0 0 10 10"
              initial={{ opacity: 0, scale: 0, x: 0, y: 0 }}
              animate={{
                opacity: [0, 1, 0],
                scale: [0, 1, 0.4],
                x: sparkle.x,
                y: sparkle.y,
              }}
              transition={{
                duration: 0.7,
                delay: sparkle.delay,
                ease: easeOutExpo,
                opacity: {
                  duration: 0.7,
                  delay: sparkle.delay,
                  times: [0, 0.3, 1],
                },
              }}
            >
              <path d={sparklePath} fill="currentColor" />
            </motion.svg>
          ))}
    </div>
  )
}

function editable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.closest("input, textarea, select, .xterm") !== null
}
