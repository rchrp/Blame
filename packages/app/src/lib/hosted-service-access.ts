import type { CloudAuthContextValue } from "@/context/cloud-auth"

/**
 * Services Blame hosts. They need an account, and Blame Premium pays for the
 * ones that cost money to run. Everything else works without an account.
 */
const hostedServices = {
  "cloud-preview": { name: "Cloud Previews", plural: true, premium: true },
  "voice-transcription": {
    name: "Cloud voice transcription",
    plural: false,
    premium: true,
  },
  "hosted-uploads": {
    name: "Hosted file uploads",
    plural: true,
    premium: true,
  },
  deployment: {
    name: "Hosted deployment uploads",
    plural: true,
    premium: true,
  },
} as const

export type HostedService = keyof typeof hostedServices

export type HostedServiceAccess =
  "available" | "account-required" | "premium-required"

export type SessionAccess = Pick<CloudAuthContextValue, "license" | "mode"> & {
  /**
   * Whether the person saved their own OpenRouter key for voice input on
   * this computer. Absent where the desktop cannot keep one.
   */
  ownSpeechKey?: "set" | "unset"
}

export function hostedServiceAccess(
  auth: SessionAccess,
  service: HostedService
): HostedServiceAccess {
  // The person's own key needs neither an account nor Blame Premium.
  if (service === "voice-transcription" && auth.ownSpeechKey === "set")
    return "available"
  if (auth.mode !== "account") return "account-required"
  if (hostedServices[service].premium && auth.license?.licensed !== true)
    return "premium-required"
  return "available"
}

/** Whether Blame Premium pays for the service. */
export function hostedServiceIsPremium(service: HostedService) {
  return hostedServices[service].premium
}

/**
 * Why the service cannot be used now, as a short sentence. A Premium service
 * names Premium even without an account: Premium is the next step, and it
 * comes with one.
 */
export function hostedServiceRequirement(
  auth: SessionAccess,
  service: HostedService
) {
  const { name, plural, premium } = hostedServices[service]
  return hostedServiceAccess(auth, service) === "account-required" && !premium
    ? `${name} ${plural ? "need" : "needs"} a Blame account`
    : `${name} ${plural ? "require" : "requires"} Blame Cloud`
}

export type HostedServiceOffer = {
  message: string
  description?: string
  /** Whether Settings can take the person's own key to unlock the service. */
  ownKey: boolean
}

/**
 * What to tell the person when the service cannot be used: the way forward
 * is Blame Cloud, and for voice input also their own OpenRouter key. Not
 * pushy: a free account is mentioned only where there is none.
 */
export function hostedServiceOffer(
  auth: SessionAccess,
  service: HostedService
): HostedServiceOffer {
  const withoutAccount = auth.mode !== "account"
  if (service === "voice-transcription" && auth.ownSpeechKey === "unset") {
    return {
      message: "Voice input is not set up yet",
      description: withoutAccount
        ? "Use your own OpenRouter key, or get it with Blame Cloud, which comes with a free account. Everything else keeps working without one."
        : "Use your own OpenRouter key, or get it with Blame Cloud.",
      ownKey: true,
    }
  }
  return {
    message: `${hostedServiceRequirement(auth, service)}.`,
    description: hostedServiceIsPremium(service)
      ? withoutAccount
        ? "Blame Cloud comes with a free account. Everything else keeps working without one."
        : undefined
      : "Everything else keeps working without one.",
    ownKey: false,
  }
}
