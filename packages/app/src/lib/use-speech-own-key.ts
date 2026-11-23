import * as React from "react"

import { usePlatform } from "@/context/platform"
import { speechOwnKeyStore } from "@/lib/speech-own-key-store"

/**
 * The cached state of the person's own OpenRouter key. `store` is absent
 * where the desktop cannot keep a key.
 */
export function useSpeechOwnKey() {
  const client = usePlatform().speechKey
  const store = React.useMemo(
    () => (client ? speechOwnKeyStore(client) : undefined),
    [client]
  )
  const status = React.useSyncExternalStore(
    React.useCallback(
      (listener) => store?.subscribe(listener) ?? (() => undefined),
      [store]
    ),
    () => store?.snapshot()
  )
  return { client, status, store }
}

/**
 * Reads the state once, then again when the window comes back into focus
 * (another window may have changed it). Mounted once, by the voice input.
 */
export function useSpeechOwnKeyRefresh() {
  const { store } = useSpeechOwnKey()
  React.useEffect(() => {
    if (!store) return
    void store.refresh()
    const refresh = () => void store.refresh()
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [store])
}
