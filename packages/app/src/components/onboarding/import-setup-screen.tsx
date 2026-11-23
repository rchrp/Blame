import { motion } from "motion/react"

import {
  finishAgentImportOffer,
  offeredScan,
} from "@/components/agent-import/agent-import-offer"
import { AgentImportPanel } from "@/components/agent-import/agent-import-panel"
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress"
import { GlassPanel } from "@/components/onboarding/stage/glass-panel"
import { usePlatform } from "@/context/platform"
import { easeOutExpo, riseIn, staggerContainer } from "@/lib/motion"

// First-run step after the provider: bring the MCP servers and skills of the
// tools the person already uses. Always skippable; works without an account.
export function ImportSetupScreen() {
  const client = usePlatform().agentImport
  const scan = offeredScan()
  if (!client || !scan) return null

  return (
    <section className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 pt-10 pb-12">
      <OnboardingProgress step="import" className="mb-4" />
      <div className="grid flex-1 items-center gap-10 md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
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
            Bring your setup.
          </motion.h1>
          <motion.p
            variants={riseIn}
            className="mt-3 text-[15px] leading-6 text-foreground/65"
          >
            Blame found servers and skills you already use in other tools.
            Pick what to bring over: nothing is changed in those tools, and
            nothing leaves this computer.
          </motion.p>
        </motion.div>
        <GlassPanel
          className="p-5"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.7, ease: easeOutExpo }}
        >
          <AgentImportPanel
            client={client}
            scan={scan}
            onFinished={finishAgentImportOffer}
            onSkip={finishAgentImportOffer}
          />
        </GlassPanel>
      </div>
    </section>
  )
}
