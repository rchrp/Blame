import * as React from "react"

import { LegalLink } from "@/components/legal/legal-link"
import { Switch } from "@/components/ui/switch"
import { usePlatform } from "@/context/platform"
import type { PrivacyPreferences } from "@/context/platform-privacy"
import { SettingsGroup, SettingsRow } from "./settings-layout"

// What Blame sends on its own: the update check. The Windows installer asks
// the same question; both answers land in the same preferences file.
export function PrivacySettingsGroup() {
  const { privacy } = usePlatform()
  const [preferences, setPreferences] =
    React.useState<PrivacyPreferences | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let active = true
    privacy
      ?.get()
      .then((value) => active && setPreferences(value))
      .catch(() => active && setError("Could not read the privacy settings."))
    return () => {
      active = false
    }
  }, [privacy])

  if (!privacy) return null

  async function update(change: Partial<PrivacyPreferences>) {
    if (!privacy || !preferences) return
    setError(null)
    try {
      setPreferences(await privacy.set({ ...preferences, ...change }))
    } catch {
      setError("Could not save the privacy settings.")
    }
  }

  return (
    <SettingsGroup
      title="Privacy"
      description="Choose what Blame sends on its own. Your code and prompts are never part of it."
    >
      <SettingsRow
        title="Check for updates at launch"
        description="Ask download.blame.so for a newer version each time Blame starts. You can still check by hand above."
      >
        <Switch
          aria-label="Toggle the update check at launch"
          checked={preferences?.updateChecks ?? true}
          disabled={!preferences}
          onCheckedChange={(updateChecks) => void update({ updateChecks })}
        />
      </SettingsRow>
      <p className="pt-3 text-sm text-muted-foreground">
        {error ?? (
          <>
            The <LegalLink page="privacy">privacy policy</LegalLink> lists
            everything Blame sends and where.
          </>
        )}
      </p>
    </SettingsGroup>
  )
}
