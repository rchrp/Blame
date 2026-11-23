import type { CredentialStorage } from "@blame/agent-runtime"

/**
 * Where a provider credential is kept, and what the person is told.
 *
 * A new key defaults to this computer only: it is a secret, and the safer
 * place is the one where it never leaves the machine. The cost (the other
 * devices will not have it) is said in the sentence under the choice. An
 * existing credential keeps the place it has until the person moves it, and
 * the account's place is the only one on a computer without a keychain.
 */
export function defaultStorage(input: {
  /** Signed in to an account: otherwise everything is on this computer. */
  accountMode: boolean
  /** Whether this computer has a keychain; undefined while it is asked. */
  keychain: boolean | undefined
  existing?: CredentialStorage
}): CredentialStorage {
  if (input.existing) return input.existing
  if (!input.accountMode) return "account"
  return input.keychain === false ? "account" : "device"
}

export type StorageCopy = {
  accountLabel: string
  accountHint: string
  deviceLabel: string
  deviceHint: string
}

export function storageCopy(kind: "key" | "sign-in"): StorageCopy {
  const what = kind === "key" ? "key" : "sign-in"
  return {
    accountLabel: "Save to my Blame account (available on your other devices)",
    accountHint: `Your ${what} is stored encrypted in your Blame account, so it works on every device you sign in on.`,
    deviceLabel: "Keep on this device only",
    deviceHint: `Your ${what} stays in this computer's keychain. It is never sent to Blame, and your other devices won't have it.`,
  }
}

/** The one sentence under the choice when only one place is possible. */
export const noKeychainNotice =
  "This computer has no secure keychain, so the key is saved to your Blame account."

/** Whether a credential moves when the person saves with this choice. */
export function movesTo(
  current: CredentialStorage | undefined,
  chosen: CredentialStorage,
  accountMode: boolean
) {
  return accountMode && chosen !== (current ?? "account")
}

/** What to send as `storage`: nothing without an account (no choice there). */
export function storageToSend(
  chosen: CredentialStorage,
  accountMode: boolean
): CredentialStorage | undefined {
  return accountMode ? chosen : undefined
}
