// What Blame does when a project opens without a preview setup: ask first,
// set it up right away, or leave it alone. The person picks the default in
// Settings; "Remember my choice" in the first-setup dialog writes it.
export type PreviewSetupPolicy = "ask" | "automatic" | "never"

export type PreviewSetupDecision = "ask" | "run" | "skip"

export function isPreviewSetupPolicy(
  value: unknown
): value is PreviewSetupPolicy {
  return value === "ask" || value === "automatic" || value === "never"
}

/**
 * Decides what happens when a project opens. `needsSetup` is whether the
 * project would be analyzed today (never analyzed, or the last run stopped
 * reporting). A project the person already declined with "Not now" is not
 * asked again during the session. Manual runs (Run again) and New Project
 * do not go through here.
 */
export function previewSetupDecision(input: {
  needsSetup: boolean
  policy: PreviewSetupPolicy
  declinedThisSession: boolean
}): PreviewSetupDecision {
  if (!input.needsSetup || input.policy === "never") return "skip"
  if (input.policy === "automatic") return "run"
  return input.declinedThisSession ? "skip" : "ask"
}
