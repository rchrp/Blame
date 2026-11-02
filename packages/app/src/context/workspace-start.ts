/**
 * What the app opens when no account session is stored. The sign-in screen
 * comes first until the person picks: once they continue without an account,
 * later launches open the local workspace directly.
 */
export type WorkspaceStart = "local" | "signed-out"

// "first-launch" greets someone new, "signed-out" someone who had an account.
export type SignInGreeting = "first-launch" | "signed-out"

const storageKey = "blame.app.workspace-start.v1"

export function readWorkspaceStart(
  storage: Pick<Storage, "getItem"> = localStorage
): WorkspaceStart | undefined {
  try {
    const value = storage.getItem(storageKey)
    return value === "local" || value === "signed-out" ? value : undefined
  } catch {
    return undefined
  }
}

export function writeWorkspaceStart(
  start: WorkspaceStart,
  storage: Pick<Storage, "setItem"> = localStorage
) {
  try {
    storage.setItem(storageKey, start)
  } catch {
    // Without storage the choice is asked again on the next launch.
  }
}

/** Opens the local workspace, or the sign-in screen with its greeting. */
export function initialWorkspace(input: {
  localAvailable: boolean
  start: WorkspaceStart | undefined
}): { open: "local" } | { open: "sign-in"; greeting: SignInGreeting } {
  if (input.localAvailable && input.start === "local") return { open: "local" }
  return {
    open: "sign-in",
    greeting: input.start === "signed-out" ? "signed-out" : "first-launch",
  }
}

export function signInTitle(input: {
  greeting: SignInGreeting
  // Signing in from a local workspace that is already open.
  fromLocalWorkspace: boolean
}) {
  if (input.fromLocalWorkspace) {
    return {
      title: "Sign in to Blame",
      description:
        "Sync your workspace across computers and use hosted services.",
    }
  }
  if (input.greeting === "signed-out") {
    return {
      title: "Welcome back",
      description: "Sign in to pick up where your agents left off.",
    }
  }
  return {
    title: "Welcome to Blame",
    description:
      "Sign in to sync your work, or start on this computer without an account.",
  }
}
