// The invitation to star Blame on GitHub: once per install, after a merge
// that worked or after the person's 3rd Quick Chat message, whichever comes
// first. Both share one flag, written before the card shows, so whatever the
// person does next, it never comes back. Storage that cannot be read or
// written means no invitation, never one on every merge or message.

export const starInviteStorageKey = "blame.app.star-invite.v1"
export const starInviteRepositoryUrl = "https://github.com/rchrp/Blame"

export const quickChatCountStorageKey = "blame.app.star-invite.messages.v1"
/** Quick Chat messages sent, install-wide, before the invitation is due. */
export const starInviteQuickChatMessages = 3

export type StarInviteTrigger = "merge" | "quick-chat"

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

/**
 * Counts one accepted Quick Chat message. True once the threshold is reached
 * and the invitation has not been shown: the count keeps its value until the
 * flag is written, so a restart before the card shows still invites on the
 * next message. Nothing is counted once the invitation was shown.
 */
export function countQuickChatMessage(
  storage: StarInviteStorage | undefined
) {
  if (!storage || !starInviteDue("merged", storage)) return false
  try {
    const stored = Number(storage.getItem(quickChatCountStorageKey))
    const count = (Number.isSafeInteger(stored) && stored > 0 ? stored : 0) + 1
    storage.setItem(quickChatCountStorageKey, String(count))
    return count >= starInviteQuickChatMessages
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
