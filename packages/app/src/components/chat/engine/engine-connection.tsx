import * as React from "react"

import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"

// The engine host reaches Blame's API with the person's own connection: for
// provider credentials, the conversations' logs and web search. It is told
// again whenever the connection changes (sign-in, token refresh, sign-out).
// A window still loading says nothing: the host serves every window, and
// the others are signed in meanwhile.
export function EngineConnection() {
  const auth = useCloudAuth()
  const engine = usePlatform().engine
  const loading = auth.status === "loading"
  const signedIn = auth.status === "authenticated"
  const { token, url } = auth.apiConnection
  React.useEffect(() => {
    if (!engine || loading) return
    void engine
      .call("connect", { api: signedIn ? { token, url } : null })
      .catch((error: unknown) =>
        console.error("The agent engine could not be connected.", error)
      )
  }, [engine, loading, signedIn, token, url])
  return null
}
