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

export type SessionAccess = Pick<CloudAuthContextValue, "license" | "mode">

export function hostedServiceAccess(
  auth: SessionAccess,
  service: HostedService
): HostedServiceAccess {
  if (auth.mode !== "account") return "account-required"
  if (hostedServices[service].premium && auth.license?.licensed !== true)
    return "premium-required"
  return "available"
}

/** Why the service cannot be used now, as a short sentence. */
export function hostedServiceRequirement(
  auth: SessionAccess,
  service: HostedService
) {
  const { name, plural } = hostedServices[service]
  return hostedServiceAccess(auth, service) === "account-required"
    ? `${name} ${plural ? "need" : "needs"} a Blame account`
    : `${name} ${plural ? "require" : "requires"} Blame Premium`
}
