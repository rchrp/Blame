import * as React from "react"
import { motion } from "motion/react"

import { cn } from "@/lib/utils"

// An empty screen that says what goes here and offers the next step.
export function EmptyState({
  action,
  className,
  description,
  icon,
  title,
}: {
  action?: React.ReactNode
  className?: string
  description: React.ReactNode
  icon: React.ReactNode
  title: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "mx-auto flex max-w-sm flex-col items-center gap-4 py-10 text-center",
        className
      )}
    >
      <EmptyStateArt icon={icon} />
      <div className="flex flex-col gap-1.5">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-pretty text-muted-foreground">
          {description}
        </p>
      </div>
      {action ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {action}
        </div>
      ) : null}
    </motion.div>
  )
}

// Two blank cards fanned behind the icon: reads as "nothing here yet"
// without a heavy illustration.
function EmptyStateArt({ icon }: { icon: React.ReactNode }) {
  return (
    <div aria-hidden="true" className="relative h-20 w-28">
      <motion.div
        className="absolute inset-x-3 top-2 h-14 rounded-xl border border-border/60 bg-muted/50"
        initial={{ rotate: 0 }}
        animate={{ rotate: -8, x: -10 }}
        transition={{ delay: 0.1, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      />
      <motion.div
        className="absolute inset-x-3 top-2 h-14 rounded-xl border border-border/60 bg-muted/50"
        initial={{ rotate: 0 }}
        animate={{ rotate: 8, x: 10 }}
        transition={{ delay: 0.1, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      />
      <motion.div
        className="absolute inset-x-5 top-1 flex h-16 items-center justify-center rounded-xl border bg-card text-muted-foreground shadow-sm [&_svg]:size-6"
        animate={{ y: [0, -3, 0] }}
        transition={{ duration: 4, ease: "easeInOut", repeat: Infinity }}
      >
        {icon}
      </motion.div>
    </div>
  )
}
