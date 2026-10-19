import * as React from "react"
import { BoxIcon, CloudIcon, FolderGit2Icon, LoaderCircleIcon } from "lucide-react"
import { motion } from "motion/react"

import { finishRuntimeOffer } from "@/components/onboarding/onboarding-flow"
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress"
import { GlassPanel } from "@/components/onboarding/stage/glass-panel"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { useBlameRuntime } from "@/context/blame-runtime"
import { useCloudAuth } from "@/context/cloud-auth"
import { useWizardKeys } from "@/lib/keyboard"
import { easeOutExpo, riseIn, staggerContainer } from "@/lib/motion"
import { cn } from "@/lib/utils"

// Last first-run step: explains where stories can run and offers to install
// the Blame Runtime for local containers. Installing happens in the
// background, so the person moves on right away.
export function RuntimeSetupScreen() {
  const runtime = useBlameRuntime()
  const auth = useCloudAuth()
  const premium = auth.license?.licensed === true
  const checking = runtime.phase === "checking"
  const repair = runtime.phase === "needs-repair"

  // Already working (found while checking): nothing to offer.
  React.useEffect(() => {
    if (runtime.phase === "ready" || runtime.phase === "unavailable") finishRuntimeOffer()
  }, [runtime.phase])

  function install() {
    if (checking) return
    void runtime.install()
    finishRuntimeOffer()
  }

  useWizardKeys({ onBack: finishRuntimeOffer, onNext: install })

  const modes = [
    {
      description: repair
        ? "An isolated sandbox on this computer. Blame Runtime is installed but needs a quick repair."
        : "An isolated sandbox on this computer. Needs Blame Runtime, a one-time install of a few minutes.",
      icon: BoxIcon,
      iconClassName: "bg-violet-500/12 text-violet-600 dark:text-violet-300",
      title: "Local Container",
      tag: "Recommended",
    },
    {
      description: "Runs in Blame's cloud. Nothing to install.",
      icon: CloudIcon,
      iconClassName: "bg-sky-500/12 text-sky-600 dark:text-sky-300",
      title: "Cloud Preview",
      tag: premium ? "Included" : "Premium",
    },
    {
      description:
        "Runs right in your project folder. The fastest and lightest, without isolation.",
      icon: FolderGit2Icon,
      iconClassName: "bg-foreground/8 text-foreground/70",
      title: "Direct",
      tag: "No install",
    },
  ]

  return (
    <section className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 pt-10 pb-12">
      <OnboardingProgress current={4} className="mb-4" />
      <div className="grid flex-1 items-center gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <motion.div
          className="max-w-md"
          variants={staggerContainer(0.07, 0.1)}
          initial="initial"
          animate="animate"
        >
          <motion.h1
            variants={riseIn}
            className="font-heading text-4xl leading-[1.05] font-bold tracking-[-0.03em]"
          >
            {repair ? "Let's fix local previews." : "Get local previews ready."}
          </motion.h1>
          <motion.p
            variants={riseIn}
            className="mt-3 text-[15px] leading-6 text-foreground/65"
          >
            Each story runs with a live preview of your app. Pick where when you
            write a story; installing Blame Runtime now keeps Local Container
            one click away.
          </motion.p>
          <motion.div
            variants={riseIn}
            className="mt-8 flex flex-wrap items-center gap-3"
          >
            <Button
              className="h-10 rounded-full px-5"
              disabled={checking || !runtime.canInstall}
              onClick={install}
            >
              {checking ? <LoaderCircleIcon className="animate-spin" /> : null}
              {checking
                ? "Checking this computer"
                : repair
                  ? "Repair Blame Runtime"
                  : "Install Blame Runtime"}
              {!checking ? <Kbd className="bg-primary-foreground/15 text-primary-foreground">↵</Kbd> : null}
            </Button>
            <Button
              variant="outline"
              className="h-10 rounded-full bg-background/60 px-4 backdrop-blur"
              onClick={finishRuntimeOffer}
            >
              Skip for now
              <Kbd>Esc</Kbd>
            </Button>
          </motion.div>
          <motion.p variants={riseIn} className="mt-3 text-xs text-foreground/50">
            It installs in the background: you can keep going. You'll find it
            again in Settings.
          </motion.p>
        </motion.div>
        <GlassPanel
          className="p-2"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.7, ease: easeOutExpo }}
        >
          <ul className="grid gap-1">
            {modes.map((mode, index) => (
              <motion.li
                key={mode.title}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.25 + index * 0.08, duration: 0.5, ease: easeOutExpo }}
                className={cn(
                  "flex items-start gap-3 rounded-2xl p-3",
                  index === 0 && "bg-white/70 ring-1 ring-black/5 dark:bg-white/[0.06] dark:ring-white/10"
                )}
              >
                <span
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-xl",
                    mode.iconClassName
                  )}
                >
                  <mode.icon className="size-5" />
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{mode.title}</span>
                    <span className="rounded-full bg-foreground/6 px-2 py-0.5 text-[10px] font-medium text-foreground/60">
                      {mode.tag}
                    </span>
                  </span>
                  <span className="text-sm text-pretty text-foreground/60">
                    {mode.description}
                  </span>
                </span>
              </motion.li>
            ))}
          </ul>
        </GlassPanel>
      </div>
    </section>
  )
}
