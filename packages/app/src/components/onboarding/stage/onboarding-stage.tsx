import * as React from "react"
import { AnimatePresence, LayoutGroup, motion } from "motion/react"
import type { HeroSceneController } from "@blame/hero-scene"

import { CompactWindowChrome } from "@/components/layout/compact-window-chrome"
import { SceneBackdrop } from "@/components/onboarding/stage/scene-backdrop"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { screenVariants } from "@/lib/motion"

export type OnboardingScreen =
  | "loading"
  | "connect"
  | "ai-setup"
  | "premium-offer"
  | "premium"
  | "welcome"

// How far the camera has travelled over the terrain on each screen. Moving
// through onboarding feels like moving forward through the landscape.
const screenTravel: Record<OnboardingScreen, number> = {
  loading: 0,
  connect: 0.12,
  "ai-setup": 0.3,
  "premium-offer": 0.78,
  premium: 0.6,
  welcome: 1,
}

type OnboardingStageContextValue = {
  // Fine-tunes travel within a screen, from 0 to 1 of the gap to the next one.
  setStepProgress(progress: number): void
  celebrate(): void
}

const OnboardingStageContext =
  React.createContext<OnboardingStageContextValue | null>(null)

export function useOnboardingStage() {
  return (
    React.useContext(OnboardingStageContext) ?? {
      setStepProgress: () => undefined,
      celebrate: () => undefined,
    }
  )
}

// One persistent stage for every screen before the workspace: the 3D scene,
// the window chrome and the toaster stay mounted while screens cross-fade on
// top, so the scene never reloads between steps.
export function OnboardingStage({
  children,
  screen,
}: {
  children: React.ReactNode
  screen: OnboardingScreen
}) {
  const controllerRef = React.useRef<HeroSceneController | null>(null)
  const screenRef = React.useRef(screen)
  // Step progress belongs to the screen that reported it, so it resets by
  // itself when the screen changes.
  const [step, setStep] = React.useState({ screen, progress: 0 })
  const stepProgress = step.screen === screen ? step.progress : 0
  const travel = stageTravel(screen, stepProgress)
  const travelRef = React.useRef(travel)

  React.useEffect(() => {
    screenRef.current = screen
  }, [screen])

  React.useEffect(() => {
    travelRef.current = travel
    controllerRef.current?.setTravel(travel)
  }, [travel])

  const handleController = React.useCallback(
    (controller: HeroSceneController | null) => {
      controllerRef.current = controller
      controller?.setTravel(travelRef.current)
    },
    []
  )

  const context = React.useMemo<OnboardingStageContextValue>(
    () => ({
      setStepProgress: (progress) =>
        setStep({ screen: screenRef.current, progress }),
      celebrate: () => controllerRef.current?.celebrate(),
    }),
    []
  )

  return (
    <OnboardingStageContext.Provider value={context}>
      <TooltipProvider>
        <main className="relative isolate h-svh overflow-hidden bg-[#eef0fb] text-foreground dark:bg-[#050712]">
          <SceneBackdrop className="-z-20" onController={handleController} />
          <StageVeil />
          <CompactWindowChrome settings={screen !== "loading"} />
          <LayoutGroup>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={screen}
                className="absolute inset-0 overflow-y-auto"
                variants={screenVariants}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </LayoutGroup>
          <Toaster />
        </main>
      </TooltipProvider>
    </OnboardingStageContext.Provider>
  )
}

function stageTravel(screen: OnboardingScreen, stepProgress: number) {
  const base = screenTravel[screen]
  if (screen !== "ai-setup") return base
  const next = screenTravel["premium-offer"]
  return base + (next - base) * Math.min(Math.max(stepProgress, 0), 1) * 0.8
}

// Softens the scene so text stays readable: a bright frosted veil in light
// mode, a deep vignette in dark mode.
function StageVeil() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_45%,rgba(255,255,255,0.5)_0%,rgba(244,245,255,0.78)_55%,rgba(240,241,252,0.94)_100%)] backdrop-blur-[2px] dark:bg-[radial-gradient(ellipse_at_50%_45%,rgba(2,4,10,0.12)_0%,rgba(2,4,10,0.38)_50%,rgba(2,4,10,0.82)_100%)] dark:backdrop-blur-0" />
      <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-white/70 to-transparent dark:from-[#050712]/70" />
    </div>
  )
}
