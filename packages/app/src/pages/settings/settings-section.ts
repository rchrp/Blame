import { navigate } from "@/components/navigation/navigation"

export type SettingsSectionId =
  | "general"
  | "models"
  | "personalization"
  | "mcp"
  | "desktop"
  | "account"

// A part of a section that opens expanded, such as an accordion.
export type SettingsItemId = "speech-own-key"

// The section (and item) the next opening of Settings shows, then forgotten.
let requestedSection: SettingsSectionId | undefined
let requestedItem: SettingsItemId | undefined

export function openSettings(section?: SettingsSectionId, item?: SettingsItemId) {
  requestedSection = section
  requestedItem = item
  navigate("/settings")
}

/** Settings on the accordion where the person's own OpenRouter key goes. */
export function openSpeechKeySettings() {
  openSettings("models", "speech-own-key")
}

export function requestedSettingsItem() {
  return requestedItem
}

export function requestedSettingsSection() {
  return requestedSection
}

export function clearRequestedSettingsSection() {
  requestedSection = undefined
  requestedItem = undefined
}
