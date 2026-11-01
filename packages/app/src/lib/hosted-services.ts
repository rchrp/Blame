import { toast } from "sonner"

import type { CloudAuthContextValue } from "@/context/cloud-auth"
import { navigate } from "@/components/navigation/navigation"
import {
  hostedServiceAccess,
  hostedServiceRequirement,
  type HostedService,
  type SessionAccess,
} from "@/lib/hosted-service-access"

/**
 * Whether the service can be used now. When it cannot, says why and offers
 * the next step: signing in, or Blame Premium.
 */
export function requestHostedService(
  auth: SessionAccess & Pick<CloudAuthContextValue, "openSignIn">,
  service: HostedService
) {
  const access = hostedServiceAccess(auth, service)
  const message = `${hostedServiceRequirement(auth, service)}.`
  if (access === "account-required") {
    toast.info(message, {
      description: "Everything else keeps working without one.",
      action: { label: "Sign in", onClick: auth.openSignIn },
    })
  } else if (access === "premium-required") {
    toast.info(message, {
      action: { label: "View Premium", onClick: () => navigate("/premium") },
    })
  }
  return access === "available"
}

/** The next step towards hosted services: sign in, or see Blame Premium. */
export function openHostedServicesOffer(
  auth: Pick<CloudAuthContextValue, "mode" | "openSignIn">
) {
  if (auth.mode === "account") navigate("/premium")
  else auth.openSignIn()
}
