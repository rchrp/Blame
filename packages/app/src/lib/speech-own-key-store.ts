import type { SpeechOwnKeyStatus } from "@blame/speech-contract"
import type { SpeechOwnKeyClient } from "@/context/platform-speech-key"

/**
 * What the app knows of the person's own OpenRouter key: the desktop's
 * answer, cached, and refreshed after a change. Never the key itself.
 */
export type SpeechOwnKeyStore = {
  /** Reads the desktop again; the previous answer stays if it cannot. */
  refresh(): Promise<SpeechOwnKeyStatus | undefined>
  /** The cached answer, or the first read when there is none yet. */
  current(): Promise<SpeechOwnKeyStatus | undefined>
  snapshot(): SpeechOwnKeyStatus | undefined
  /** Takes an answer the desktop just gave (after a save or a removal). */
  set(status: SpeechOwnKeyStatus): void
  subscribe(listener: () => void): () => void
}

export function createSpeechOwnKeyStore(
  client: SpeechOwnKeyClient
): SpeechOwnKeyStore {
  let status: SpeechOwnKeyStatus | undefined
  let reading: Promise<SpeechOwnKeyStatus | undefined> | undefined
  const listeners = new Set<() => void>()
  const publish = (next: SpeechOwnKeyStatus) => {
    status = next
    for (const listener of listeners) listener()
  }
  const store: SpeechOwnKeyStore = {
    refresh() {
      reading ??= client
        .status()
        .then((next) => {
          publish(next)
          return next
        })
        .catch(() => status)
        .finally(() => {
          reading = undefined
        })
      return reading
    },
    current: () => (status ? Promise.resolve(status) : store.refresh()),
    snapshot: () => status,
    set: publish,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return store
}

const stores = new WeakMap<SpeechOwnKeyClient, SpeechOwnKeyStore>()

/** One store per desktop bridge, shared by Settings and the voice input. */
export function speechOwnKeyStore(client: SpeechOwnKeyClient) {
  let store = stores.get(client)
  if (!store) {
    store = createSpeechOwnKeyStore(client)
    stores.set(client, store)
  }
  return store
}

/** What the access rules take: absent where no key can be kept. */
export function ownSpeechKeyAccess(
  status: SpeechOwnKeyStatus | undefined
): "set" | "unset" | undefined {
  if (!status) return undefined
  return status.configured ? "set" : "unset"
}
