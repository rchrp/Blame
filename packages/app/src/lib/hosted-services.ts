import * as React from "react"
import { toast } from "sonner"

import type { CloudAuthContextValue } from "@/context/cloud-auth"
import { navigate } from "@/components/navigation/navigation"
import {
  hostedServiceAccess,
  hostedServiceIsPremium,
  hostedServiceOffer,
  type HostedService,
  type SessionAccess,
} from "@/lib/hosted-service-access"
import { openSpeechKeySettings } from "@/pages/settings/settings-section"

/**
 * Whether the service can be used now. When it cannot, says why and offers
 * the next step: Blame Premium for a Premium service, signing in otherwise.
 * Voice input also offers the person's own OpenRouter key, where one can be kept.
 */
export function requestHostedService(
  auth: SessionAccess & Pick<CloudAuthContextValue, "openSignIn">,
  service: HostedService
) {
  const access = hostedServiceAccess(auth, service)
  if (access === "available") return true
  const { description, message, ownKey } = hostedServiceOffer(auth, service)
  if (ownKey) {
    // Two ways forward, none pushed: the person's own key (the button), or
    // Blame Cloud (a link). Two buttons would squeeze the text to nothing.
    const id = toast.info(message, {
      description: React.createElement(
        "span",
        null,
        description,
        " ",
        React.createElement(
          "button",
          {
            className: "font-medium underline underline-offset-2",
            onClick: () => {
              toast.dismiss(id)
              openHostedServicesOffer()
            },
            type: "button",
          },
          "View Blame Cloud"
        )
      ),
      duration: 12_000,
      action: {
        label: "Add your OpenRouter key",
        onClick: openSpeechKeySettings,
      },
    })
  } else if (hostedServiceIsPremium(service)) {
    toast.info(message, {
      description,
      action: { label: "View Blame Cloud", onClick: openHostedServicesOffer },
    })
  } else {
    toast.info(message, {
      description,
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
