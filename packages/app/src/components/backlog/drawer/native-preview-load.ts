// Whether a native preview browser needs its page loaded. When a preview's
// address arrives, its session key changes, and for one render the browser
// id still belongs to the previous session. Loading then would put the page
// in the old browser and mark the new session loaded, so its own browser
// would never load and its preview would spin forever.

type Session = {
  browserId?: string
  source?: string
  state?: { error?: string | null }
}

export function nativePreviewLoadDecision(input: {
  browserId: string | undefined
  session: Session | undefined
  source: string
  sourceChanged: boolean
}): "skip" | "reuse" | "load" {
  const { browserId, session, source, sourceChanged } = input
  if (!browserId || !source) return "skip"
  if (!session || session.browserId !== browserId) return "skip"
  if (session.source === source && !sourceChanged && !session.state?.error)
    return "reuse"
  return "load"
}
