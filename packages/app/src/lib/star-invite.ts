// The invitation to star Blame on GitHub: once per install, after a merge
// that worked. The flag is written before the card shows, so whatever the
// person does next, it never comes back. Storage that cannot be read or
// written means no invitation, never one on every merge.

export const starInviteStorageKey = "blame.app.star-invite.v1"
export const starInviteRepositoryUrl = "https://github.com/rchrp/Blame"

export type MergeOutcome = "merged" | "failed"

type StarInviteStorage = Pick<Storage, "getItem" | "setItem">

/** Whether this merge may lead to the invitation. */
export function starInviteDue(
  outcome: MergeOutcome,
  storage: Pick<Storage, "getItem"> | undefined
) {
  if (outcome !== "merged" || !storage) return false
  try {
    return storage.getItem(starInviteStorageKey) === null
  } catch {
    return false
  }
}

/** Records the invitation as shown, right before it shows. False: don't show. */
export function claimStarInvite(
  storage: StarInviteStorage | undefined,
  now = new Date()
) {
  if (!storage || !starInviteDue("merged", storage)) return false
  try {
    storage.setItem(
      starInviteStorageKey,
      JSON.stringify({ shownAt: now.toISOString() })
    )
    return true
  } catch {
    return false
  }
}

/** The window's storage, or undefined where even reaching it throws. */
export function browserStorage() {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}
