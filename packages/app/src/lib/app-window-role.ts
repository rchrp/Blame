export type AppWindowRole = "compact" | "workspace"

export type AppWindowRoleInput = {
  activeProject: unknown
  aiPreferences: unknown
  authStatus: "authenticated" | "loading" | "unauthenticated"
  premiumOpen: boolean
  statusPipOpen: boolean
}

export function appWindowRole(
  input: AppWindowRoleInput
): AppWindowRole | undefined {
  if (input.statusPipOpen || input.authStatus === "loading") return
  if (input.authStatus === "unauthenticated") return "compact"
  if (input.premiumOpen) return "compact"
  if (input.aiPreferences === null) return "compact"
  return input.activeProject ? "workspace" : "compact"
}
