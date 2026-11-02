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

/** The role the desktop loaded this window with; none outside the desktop. */
export function loadedWindowRole(search: string): AppWindowRole | undefined {
  const role = new URLSearchParams(search).get("window-role")
  return role === "compact" || role === "workspace" ? role : undefined
}

/**
 * A compact window that now needs the workspace is about to be replaced by
 * a workspace window. Until then it must not start work, such as a project
 * analysis, whose result would be lost with it.
 */
export function windowAwaitsReplacement(
  loaded: AppWindowRole | undefined,
  wanted: AppWindowRole | undefined
) {
  return loaded === "compact" && wanted === "workspace"
}
