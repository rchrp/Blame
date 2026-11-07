import * as React from "react"
import { toast } from "sonner"

import { useCloudAuth } from "@/context/cloud-auth"
import { personalizationStore } from "@/lib/personalization-store"
import { parseNotch, type PersonalizationSetting } from "@/lib/personalization"

// The account's settings, shared by every place that shows them. `ready` is
// false until the account's preferences are loaded.
export function usePersonalization() {
  const auth = useCloudAuth()
  const account =
    auth.status === "authenticated"
      ? auth.aiPreferences?.personalization
      : undefined
  const save = auth.savePersonalization

  React.useEffect(() => {
    if (account) personalizationStore.hydrate(account)
  }, [account])

  const personalization = React.useSyncExternalStore(
    personalizationStore.subscribe,
    personalizationStore.get,
    personalizationStore.get
  )

  const change = React.useCallback(
    (setting: PersonalizationSetting, value: string) => {
      const notch = parseNotch(setting, value)
      if (notch === undefined) return Promise.resolve()
      return personalizationStore
        .change(setting, notch, save)
        .catch((error) => {
          toast.error("Your personalization could not be saved", {
            description: error instanceof Error ? error.message : undefined,
          })
        })
    },
    [save]
  )

  return { change, personalization, ready: Boolean(account) }
}

// Keeps the shared settings in step with the account for the whole app, so
// that an agent started anywhere is told what the account holds.
export function PersonalizationSync() {
  usePersonalization()
  return null
}
