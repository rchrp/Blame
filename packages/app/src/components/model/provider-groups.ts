import type { BlameProvider as Provider } from "@blame/agent-runtime"

import {
  recommendedApiKeyProviders,
  subscriptionProviders,
} from "@/components/model/model-selection"

export type ProviderGroupID = "subscription" | "api-keys" | "more"

export type ProviderGroup = {
  id: ProviderGroupID
  name: string
  providers: Provider[]
}

const providerSections = [
  {
    id: "subscription",
    name: "Use your subscription",
    providerIDs: subscriptionProviders,
  },
  { id: "api-keys", name: "API keys", providerIDs: recommendedApiKeyProviders },
] as const

/**
 * Subscriptions first, then the recommended API keys, then everything else.
 * The connect dialog and onboarding both list providers in this order.
 */
export function groupProviders(providers: Provider[]): ProviderGroup[] {
  const listed = new Set<string>(
    providerSections.flatMap((section) => section.providerIDs)
  )
  return [
    ...providerSections.map((section) => ({
      id: section.id,
      name: section.name,
      providers: section.providerIDs.flatMap((id) =>
        providers.filter((provider) => provider.id === id)
      ),
    })),
    {
      id: "more" as const,
      name: "More providers",
      providers: providers
        .filter((provider) => !listed.has(provider.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
  ].filter((group) => group.providers.length)
}
