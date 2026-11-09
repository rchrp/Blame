// What the desktop app sends on its own, without the user picking the
// destination: the update check at launch.
export type PrivacyPreferences = {
  updateChecks: boolean
}

export type PrivacyClient = {
  get(): Promise<PrivacyPreferences>
  set(preferences: PrivacyPreferences): Promise<PrivacyPreferences>
}
