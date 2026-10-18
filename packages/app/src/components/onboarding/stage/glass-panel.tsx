import * as React from "react"
import { motion, type HTMLMotionProps } from "motion/react"

import { cn } from "@/lib/utils"

// Frosted card that floats over the onboarding scene.
export const GlassPanel = React.forwardRef<
  HTMLDivElement,
  HTMLMotionProps<"div">
>(function GlassPanel({ className, children, ...props }, ref) {
  return (
    <motion.div
      ref={ref}
      className={cn(
        "relative rounded-3xl border border-white/80 bg-white/75 shadow-[0_30px_80px_-24px_rgba(28,36,120,0.38),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl",
        "dark:border-white/10 dark:bg-[#0b0f22]/70 dark:shadow-[0_30px_90px_-20px_rgba(0,0,0,0.75),inset_0_1px_0_rgba(255,255,255,0.06)]",
        className
      )}
      {...props}
    >
      {children}
    </motion.div>
  )
})
