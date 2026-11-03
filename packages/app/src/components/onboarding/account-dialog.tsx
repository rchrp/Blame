import * as React from "react"
import { XIcon } from "lucide-react"
import { motion } from "motion/react"
import type { PricingBillingCycle } from "@blame/pricing-card"

import { ConnectPanel } from "@/components/onboarding/connect-screen"
import { GlassPanel } from "@/components/onboarding/stage/glass-panel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useCloudAuth } from "@/context/cloud-auth"
import { easeOutExpo } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { PremiumPanel } from "@/pages/premium/page"

export type AccountView = "sign-in" | "premium"

const viewTitles: Record<AccountView, string> = {
  "sign-in": "Sign in to Blame",
  premium: "Blame Cloud",
}

/**
 * Signing in or Blame Premium, asked for once the workspace is open. During
 * first-run setup they show as setup steps; in the app, as a popup
 * (AccountDialog). Without an account, getting Premium signs in first and
 * keeps the chosen cycle, so the checkout opens once signed in.
 */
export function useAccountFlow(premiumOpen: boolean) {
  const auth = useCloudAuth()
  const view: AccountView | null =
    auth.status !== "authenticated"
      ? null
      : auth.signIn.open
        ? "sign-in"
        : premiumOpen
          ? "premium"
          : null
  const [resumeCheckout, setResumeCheckout] =
    React.useState<PricingBillingCycle | null>(null)

  // Leaving sign-in without an account drops the checkout it was for.
  if (resumeCheckout && !auth.signIn.open && auth.mode !== "account")
    setResumeCheckout(null)

  return {
    view,
    premium: {
      onSignInFirst(cycle: PricingBillingCycle) {
        setResumeCheckout(cycle)
        auth.openSignIn()
      },
      resumeCheckout,
      onCheckoutResumed: () => setResumeCheckout(null),
    },
  }
}

export type AccountFlow = ReturnType<typeof useAccountFlow>

/**
 * The account flow as a popup over the app, built from the same panels as
 * the setup steps. Closing it returns to the app; closing sign-in opened from
 * Premium goes back to Premium.
 */
export function AccountDialog({
  flow,
  onPremiumClose,
}: {
  flow: AccountFlow
  onPremiumClose(): void
}) {
  const auth = useCloudAuth()
  const { view } = flow
  // The content stays while the popup fades out.
  const [shown, setShown] = React.useState(view)
  if (view && view !== shown) setShown(view)

  function close() {
    // The local workspace is moving into the account: let it finish.
    if (auth.signIn.transferring) return
    if (view === "sign-in") auth.closeSignIn()
    else onPremiumClose()
  }

  return (
    <Dialog open={view !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        overlayClassName="bg-black/30 supports-backdrop-filter:backdrop-blur-sm"
        className={cn(
          "max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto rounded-3xl bg-transparent p-0 ring-0",
          shown === "premium" ? "sm:max-w-4xl" : "sm:max-w-[22rem]"
        )}
      >
        {shown ? (
          <TooltipProvider>
            <DialogTitle className="sr-only">{viewTitles[shown]}</DialogTitle>
            <motion.div
              key={shown}
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.35, ease: easeOutExpo }}
            >
              {shown === "sign-in" ? (
                <ConnectPanel />
              ) : (
                <GlassPanel className="overflow-hidden">
                  <PremiumPanel
                    variant="dialog"
                    onLeave={close}
                    {...flow.premium}
                  />
                </GlassPanel>
              )}
            </motion.div>
          </TooltipProvider>
        ) : null}
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-3.5 right-3.5 z-10 rounded-full text-foreground/60 hover:text-foreground"
            disabled={auth.signIn.transferring}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  )
}
