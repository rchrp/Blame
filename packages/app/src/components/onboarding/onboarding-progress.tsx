import { CheckIcon } from "lucide-react"
import { motion } from "motion/react"

import { springSnappy } from "@/lib/motion"
import { cn } from "@/lib/utils"

const journey = ["Account", "Provider", "Models", "Premium", "Runtime"] as const

// Where the person stands in the first-run journey. Account is always done by
// the time this shows.
export function OnboardingProgress({
  current,
  className,
}: {
  current: number
  className?: string
}) {
  return (
    <ol
      aria-label="Setup progress"
      className={cn("flex items-center justify-center gap-1.5", className)}
    >
      {journey.map((label, index) => {
        const done = index < current
        const active = index === current
        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className="flex items-center gap-1.5"
          >
            <span
              className={cn(
                "relative flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-foreground/50 transition-colors duration-300",
                (done || active) && "text-foreground"
              )}
            >
              {active ? (
                <motion.span
                  layoutId="onboarding-progress-pill"
                  className="absolute inset-0 rounded-full bg-white/80 shadow-sm ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10"
                  transition={springSnappy}
                />
              ) : null}
              <span
                className={cn(
                  "relative flex size-4 items-center justify-center rounded-full border border-current/30 text-[10px] transition-colors duration-300",
                  done && "border-primary bg-primary text-primary-foreground",
                  active && "border-primary text-primary dark:border-indigo-300 dark:text-indigo-200"
                )}
              >
                {done ? (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={springSnappy}
                  >
                    <CheckIcon className="size-2.5" strokeWidth={3} />
                  </motion.span>
                ) : (
                  index + 1
                )}
              </span>
              <span className="relative">{label}</span>
            </span>
            {index < journey.length - 1 ? (
              <span className="relative h-px w-5 overflow-hidden bg-foreground/15">
                <motion.span
                  className="absolute inset-0 origin-left bg-primary"
                  initial={false}
                  animate={{ scaleX: done ? 1 : 0 }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                />
              </span>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
