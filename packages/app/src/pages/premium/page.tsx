import * as React from "react"
import {
  ArrowRightIcon,
  CheckIcon,
  CloudIcon,
  LoaderCircleIcon,
  MicIcon,
  SparklesIcon,
  UploadCloudIcon,
} from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { toast } from "sonner"

import { BlameLogoMark } from "@/components/brand/blame-logo-mark"
import { LegalLink } from "@/components/legal/legal-link"
import { navigate } from "@/components/navigation/navigation"
import { dismissPremiumOffer } from "@/components/onboarding/onboarding-flow"
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress"
import { GlassPanel } from "@/components/onboarding/stage/glass-panel"
import { useOnboardingStage } from "@/components/onboarding/stage/onboarding-stage"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { useCloudAuth } from "@/context/cloud-auth"
import { useWizardKeys } from "@/lib/keyboard"
import { easeOutExpo, riseIn, springSnappy, staggerContainer } from "@/lib/motion"
import { cn } from "@/lib/utils"

const billingOptions = {
  monthly: { label: "Monthly", price: 20, suffix: "USD / month", note: "" },
  yearly: {
    label: "Yearly",
    price: 200,
    suffix: "USD / year",
    note: "Billed once a year. Two months free.",
  },
} as const

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

const licenseFacts = [
  "Existing usage limits apply",
  "Local work and your own AI providers stay free",
  "Cancel anytime",
] as const

type BillingCycle = keyof typeof billingOptions
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
  const [billingCycle, setBillingCycle] =
    React.useState<BillingCycle>("monthly")
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
      <div className="grid flex-1 items-center gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <motion.div
          className="max-w-md"
          variants={staggerContainer(0.07, 0.1)}
          initial="initial"
          animate="animate"
        >
          <motion.p
            variants={riseIn}
            className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary dark:bg-indigo-400/15 dark:text-indigo-200"
          >
            <SparklesIcon className="size-3.5" />
            {offer ? "Optional · One last thing" : "Blame Premium"}
          </motion.p>
          <motion.h1
            variants={riseIn}
            className="font-heading text-4xl leading-[1.05] font-bold tracking-[-0.03em]"
          >
            {offer ? "Take Blame to the cloud." : "Blame Premium"}
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
            {offer ? (
              <Button
                variant="outline"
                className="h-10 rounded-full bg-background/60 px-4 backdrop-blur"
                onClick={leave}
              >
                Continue with free
                <Kbd>Esc</Kbd>
              </Button>
            ) : (
              <Button variant="outline" className="h-10 rounded-full bg-background/60 px-4 backdrop-blur" onClick={leave}>
                Continue using Blame
                <Kbd>Esc</Kbd>
              </Button>
            )}
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
        <div className="flex w-full flex-col items-center">
          <PricingCard
            billingCycle={billingCycle}
            premium={premium}
            loading={actions.pending === (premium ? "portal" : billingCycle)}
            disabled={actions.pending !== null}
            onBillingCycleChange={setBillingCycle}
            onCheckout={premium ? () => actions.manage() : actions.checkout}
          />
          <LicenseError error={actions.error} />
        </div>
      </div>
    </section>
  )
}

function PricingCard({
  billingCycle,
  disabled,
  loading,
  premium,
  onBillingCycleChange,
  onCheckout,
}: PricingCardProps) {
  const selected = billingOptions[billingCycle]

  return (
    <GlassPanel
      initial={{ opacity: 0, y: 28, scale: 0.96, rotateX: 8 }}
      animate={{ opacity: 1, y: 0, scale: 1, rotateX: 0 }}
      transition={{ delay: 0.15, duration: 0.8, ease: easeOutExpo }}
      style={{ transformPerspective: 1200 }}
      className="w-full overflow-hidden p-5"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 -right-20 size-56 rounded-full bg-[radial-gradient(circle,rgba(120,130,255,0.35),transparent_70%)] blur-2xl"
      />
      <header className="relative flex items-center gap-3">
        <BlameLogoMark className="size-10" />
        <div>
          <h2 className="font-heading text-lg font-semibold tracking-tight">
            Premium cloud services
          </h2>
          <p className="text-xs text-foreground/60">
            Hosted and funded by Blame.
          </p>
        </div>
      </header>
      <BillingSelector
        value={billingCycle}
        disabled={disabled}
        onChange={onBillingCycleChange}
      />
      <div className="relative mt-6 flex items-end gap-2">
        <AnimatedPrice value={selected.price} />
        <span className="pb-1.5 text-sm text-foreground/55">{selected.suffix}</span>
      </div>
      <p className="mt-1 h-5 text-xs font-medium text-foreground/55">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={billingCycle}
            className="inline-block"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
          >
            {selected.note}
          </motion.span>
        </AnimatePresence>
      </p>
      <Button
        className="group relative mt-5 h-11 w-full overflow-hidden rounded-full text-base shadow-[0_14px_30px_-12px_var(--primary)] transition-[transform,box-shadow] duration-200 hover:-translate-y-px hover:shadow-[0_18px_36px_-12px_var(--primary)] active:scale-[0.99]"
        disabled={disabled}
        onClick={() => onCheckout(billingCycle)}
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-0 -left-1/3 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/35 to-transparent motion-safe:animate-[premium-sheen_3.2s_ease-in-out_infinite]"
        />
        {loading ? <LoaderCircleIcon className="animate-spin" /> : null}
        {loading
          ? "Opening billing"
          : premium
            ? "Manage subscription"
            : "Get Premium"}
      </Button>
      <ul className="mt-5 grid gap-2 text-sm">
        {licenseFacts.map((fact) => (
          <li key={fact} className="flex items-center gap-2 text-foreground/75">
            <CheckIcon className="size-3.5 shrink-0 text-primary dark:text-indigo-300" aria-hidden="true" />
            <span>{fact}</span>
          </li>
        ))}
      </ul>
      <PurchaseLegalLinks />
      <p className="mt-2 text-center text-[11px] leading-4 text-foreground/50">
        AI usage is not included and may be billed separately by your provider.
      </p>
    </GlassPanel>
  )
}

// Digits roll when the price changes.
function AnimatedPrice({ value }: { value: number }) {
  return (
    <span className="relative inline-flex h-14 overflow-hidden font-heading text-5xl leading-[3.5rem] font-bold tracking-[-0.04em] tabular-nums">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: "70%", opacity: 0, filter: "blur(4px)" }}
          animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
          exit={{ y: "-70%", opacity: 0, filter: "blur(4px)" }}
          transition={springSnappy}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

function BillingSelector({
  disabled,
  value,
  onChange,
}: {
  disabled: boolean
  value: BillingCycle
  onChange(cycle: BillingCycle): void
}) {
  const cycles = Object.keys(billingOptions) as BillingCycle[]

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const next = cycles[(cycles.indexOf(value) + 1) % cycles.length]
    onChange(next)
    const button = event.currentTarget.querySelector<HTMLButtonElement>(
      `[data-cycle="${next}"]`
    )
    button?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label="Billing cycle"
      className="relative mt-5 grid grid-cols-2 rounded-full bg-foreground/[0.06] p-1 text-sm font-semibold"
      onKeyDown={handleKeyDown}
    >
      {cycles.map((cycle) => {
        const selected = cycle === value
        return (
          <button
            key={cycle}
            type="button"
            role="radio"
            data-cycle={cycle}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            className={cn(
              "relative rounded-full px-4 py-2 outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
              selected ? "text-foreground" : "text-foreground/55 hover:text-foreground"
            )}
            onClick={() => onChange(cycle)}
          >
            {selected ? (
              <motion.span
                layoutId="billing-cycle-pill"
                className="absolute inset-0 rounded-full bg-background shadow-[0_6px_18px_rgba(0,0,0,0.12)] dark:bg-white/15"
                transition={springSnappy}
              />
            ) : null}
            <span className="relative inline-flex items-center gap-1.5">
              {billingOptions[cycle].label}
              {cycle === "yearly" ? (
                <span className="rounded-full bg-emerald-500/15 px-1.5 py-px text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                  −17%
                </span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function PurchaseLegalLinks() {
  return (
    <nav
      aria-label="Purchase policies"
      className="mt-5 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[11px] leading-5 text-foreground/55"
    >
      <LegalLink page="terms" className="hover:text-foreground">
        Terms
      </LegalLink>
      <LegalLink page="privacy" className="hover:text-foreground">
        Privacy
      </LegalLink>
      <LegalLink page="refund" className="hover:text-foreground">
        Refunds
      </LegalLink>
      <LegalLink page="withdrawal" className="hover:text-foreground">
        Withdrawal
      </LegalLink>
    </nav>
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

type PricingCardProps = {
  premium: boolean
  billingCycle: BillingCycle
  disabled: boolean
  loading: boolean
  onBillingCycleChange(cycle: BillingCycle): void
  onCheckout(cycle: BillingCycle): void
}

type LicenseActionState = {
  manage(): void
  error: string | null
  pending: PendingAction | null
  checkout(cycle: BillingCycle): void
  refresh(): void
}
