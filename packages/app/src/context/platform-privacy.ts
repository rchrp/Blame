// What the desktop app sends on its own, without the user picking the
// destination: usage telemetry and the update check at launch.
export type PrivacyPreferences = {
  telemetry: boolean
  updateChecks: boolean
}

export type PrivacyClient = {
  get(): Promise<PrivacyPreferences>
  set(preferences: PrivacyPreferences): Promise<PrivacyPreferences>
}
