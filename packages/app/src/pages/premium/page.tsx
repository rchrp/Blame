import * as React from "react"
import {
  ArrowRightIcon,
  CloudIcon,
  LoaderCircleIcon,
  MicIcon,
  UploadCloudIcon,
} from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { toast } from "sonner"
import {
  PricingCard,
  pricingCardActionClassName,
  pricingLegalLinkClassName,
  type PricingBillingCycle,
} from "@blame/pricing-card"

import { LegalLink } from "@/components/legal/legal-link"
import { navigate } from "@/components/navigation/navigation"
import { dismissPremiumOffer } from "@/components/onboarding/onboarding-flow"
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress"
import { useOnboardingStage } from "@/components/onboarding/stage/onboarding-stage"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { useCloudAuth } from "@/context/cloud-auth"
import { useWizardKeys } from "@/lib/keyboard"
import { easeOutExpo, riseIn, staggerContainer } from "@/lib/motion"
import { publicAssetUrl } from "@/lib/public-asset-url"

const premiumFeatures = [
  {
    icon: CloudIcon,
    title: "Managed cloud previews",
    description: "Share a running preview of any story, no local setup.",
  },
  {
    icon: MicIcon,
    title: "Cloud voice transcription",
    description: "Dictate stories and comments, transcribed in the cloud.",
  },
  {
    icon: UploadCloudIcon,
    title: "Hosted file uploads",
    description: "Attach files and deployment sources to your work.",
  },
] as const

type BillingCycle = PricingBillingCycle
type PendingAction = BillingCycle | "refresh" | "portal"

// The Premium page, reached from settings or a Premium-only feature.
export function PremiumScreen() {
  return <PremiumPanel variant="page" />
}

// The one-time Premium step at the end of first-run setup.
export function PremiumOfferScreen() {
  return <PremiumPanel variant="offer" />
}

function PremiumPanel({ variant }: { variant: "offer" | "page" }) {
  const auth = useCloudAuth()
  const stage = useOnboardingStage()
  const premium = auth.license?.licensed === true
  const actions = useLicenseActions()
  const offer = variant === "offer"
  const wasPremium = React.useRef(premium)

  React.useEffect(() => {
    if (premium && !wasPremium.current) stage.celebrate()
    wasPremium.current = premium
  }, [premium, stage])

  function leave() {
    if (offer) dismissPremiumOffer()
    else navigate("/backlog")
  }

  useWizardKeys({ onBack: leave })

  return (
    <section className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 pt-10 pb-12">
      {offer ? <OnboardingProgress current={3} className="mb-4" /> : null}
      <div className="grid flex-1 items-center gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,27.5rem)]">
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
            Take Blame to the cloud.
          </motion.h1>
          <motion.p
            variants={riseIn}
            className="mt-3 text-[15px] leading-6 text-foreground/65"
          >
            Cloud previews, voice and uploads, hosted by Blame. Everything
            local, and your own AI providers, stay free.
          </motion.p>
          <motion.ul className="mt-7 grid gap-3" variants={staggerContainer(0.08)}>
            {premiumFeatures.map((feature) => (
              <motion.li
                key={feature.title}
                variants={riseIn}
                className="flex items-start gap-3"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/90 to-indigo-500 text-primary-foreground shadow-[0_8px_20px_-8px_var(--primary)]">
                  <feature.icon className="size-4" />
                </span>
                <span className="grid gap-0.5">
                  <span className="text-sm font-semibold">{feature.title}</span>
                  <span className="text-sm text-foreground/60">
                    {feature.description}
                  </span>
                </span>
              </motion.li>
            ))}
          </motion.ul>
          <motion.div
            variants={riseIn}
            className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2"
          >
            <Button
              variant="outline"
              className="h-10 rounded-full bg-background/60 px-4 backdrop-blur"
              onClick={leave}
            >
              {offer ? "Continue with free" : "Continue using Blame"}
              <Kbd>Esc</Kbd>
            </Button>
            <Button
              variant="link"
              className="h-10 px-0 dark:text-indigo-300"
              disabled={actions.pending !== null}
              onClick={actions.refresh}
            >
              I completed payment
              {actions.pending === "refresh" ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <ArrowRightIcon />
              )}
            </Button>
          </motion.div>
          {offer ? (
            <motion.p variants={riseIn} className="mt-2 text-xs text-foreground/50">
              You can upgrade anytime from Settings.
            </motion.p>
          ) : null}
        </motion.div>
        <motion.div
          className="flex w-full flex-col items-center"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.7, ease: easeOutExpo }}
        >
          <PricingCard
            compact
            disabled={actions.pending !== null}
            logo={
              <img
                src={publicAssetUrl("blame-dark-app-icon-192.png")}
                alt=""
                className="object-contain"
              />
            }
            action={(cycle) => {
              const loading = actions.pending === (premium ? "portal" : cycle)
              return (
                <button
                  type="button"
                  className={pricingCardActionClassName}
                  disabled={actions.pending !== null}
                  onClick={() =>
                    premium ? actions.manage() : actions.checkout(cycle)
                  }
                >
                  {loading ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
                  {loading
                    ? "Opening billing"
                    : premium
                      ? "Manage subscription"
                      : "Get Premium"}
                </button>
              )
            }}
            legalLinks={
              <>
                <LegalLink page="terms" className={pricingLegalLinkClassName}>
                  Terms
                </LegalLink>
                <LegalLink page="privacy" className={pricingLegalLinkClassName}>
                  Privacy
                </LegalLink>
                <LegalLink page="refund" className={pricingLegalLinkClassName}>
                  Refunds
                </LegalLink>
                <LegalLink page="withdrawal" className={pricingLegalLinkClassName}>
                  Withdrawal
                </LegalLink>
              </>
            }
          />
          <LicenseError error={actions.error} />
        </motion.div>
      </div>
    </section>
  )
}

function LicenseError({ error }: { error: string | null }) {
  return (
    <AnimatePresence>
      {error ? (
        <motion.p
          role="alert"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          className="mt-4 w-full rounded-xl bg-destructive/10 px-4 py-3 text-center text-sm text-destructive"
        >
          {error}
        </motion.p>
      ) : null}
    </AnimatePresence>
  )
}

function useLicenseActions(): LicenseActionState {
  const auth = useCloudAuth()
  const [pending, setPending] = React.useState<PendingAction | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function run(name: PendingAction, action: () => Promise<void>) {
    setPending(name)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(null)
    }
  }

  return {
    error,
    pending,
    checkout: (cycle) => void run(cycle, () => auth.startCheckout(cycle)),
    manage: () => void run("portal", () => auth.openBillingPortal()),
    refresh: () =>
      void run("refresh", async () => {
        const license = await auth.refreshLicense()
        if (license?.licensed !== false) return
        toast.info("No active subscription found", {
          id: "license-not-found",
          description:
            "If you just completed payment, wait a few seconds and try again.",
          position: "bottom-right",
        })
      }),
  }
}

function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Unable to complete the request. Please try again."
}

type LicenseActionState = {
  manage(): void
  error: string | null
  pending: PendingAction | null
  checkout(cycle: BillingCycle): void
  refresh(): void
}
