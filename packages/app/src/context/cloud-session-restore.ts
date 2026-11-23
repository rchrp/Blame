/**
 * Whether the account itself refused the stored session (an expired or
 * revoked token): only then is the person signed out. An API that cannot be
 * reached, or that fails for a moment, leaves the session as it was: signing
 * out on a network error would take the person out of their own workspace
 * whenever Blame's servers restart.
 */
export function sessionRejected(error: unknown) {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status: unknown }).status
      : undefined
  return status === 401 || status === 403
}
