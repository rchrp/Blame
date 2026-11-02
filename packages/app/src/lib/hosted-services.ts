import { toast } from "sonner"

import type { CloudAuthContextValue } from "@/context/cloud-auth"
import { navigate } from "@/components/navigation/navigation"
import {
  hostedServiceAccess,
  hostedServiceIsPremium,
  hostedServiceRequirement,
  type HostedService,
  type SessionAccess,
} from "@/lib/hosted-service-access"

/**
 * Whether the service can be used now. When it cannot, says why and offers
 * the next step: Blame Premium for a Premium service, signing in otherwise.
 */
export function requestHostedService(
  auth: SessionAccess & Pick<CloudAuthContextValue, "openSignIn">,
  service: HostedService
) {
  const access = hostedServiceAccess(auth, service)
  if (access === "available") return true
  const message = `${hostedServiceRequirement(auth, service)}.`
  if (hostedServiceIsPremium(service)) {
    toast.info(message, {
      description:
        auth.mode === "account"
          ? undefined
          : "Premium comes with a free account. Everything else keeps working without one.",
      action: { label: "View Premium", onClick: openHostedServicesOffer },
    })
  } else {
    toast.info(message, {
      description: "Everything else keeps working without one.",
      action: { label: "Sign in", onClick: auth.openSignIn },
    })
  }
  return false
}

/**
 * Blame Premium, in the account popup. Without an account, getting Premium
 * there signs in first.
 */
export function openHostedServicesOffer() {
  navigate("/premium")
}
