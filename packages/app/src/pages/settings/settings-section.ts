import { navigate } from "@/components/navigation/navigation"

export type SettingsSectionId =
  | "general"
  | "models"
  | "mcp"
  | "desktop"
  | "account"

// The section the next opening of Settings shows, then forgotten.
let requestedSection: SettingsSectionId | undefined

export function openSettings(section?: SettingsSectionId) {
  requestedSection = section
  navigate("/settings")
}

export function requestedSettingsSection() {
  return requestedSection
}

export function clearRequestedSettingsSection() {
  requestedSection = undefined
}
