type Listener = () => void

export type UltraStorage = Pick<Storage, "getItem" | "setItem">

const storageKey = "blame.conversation-ultra.v1"

// The new chat, before its first message gives it an identity.
export const newChatUltraKey = "chat:new"

export function chatUltraKey(chatId?: string) {
  return chatId ? `chat:${chatId}` : newChatUltraKey
}

export function storyUltraKey(storyId: string) {
  return `story:${storyId}`
}

// Whether ultra mode is on in a conversation's composer. It stays as set,
// conversation by conversation, until it is unchecked; each message sent
// records the state it was sent in (`UserBlock::Ultra`), so this is only
// what the next message starts from.
export function createConversationUltraStore(storage?: UltraStorage) {
  let on = read(storage)
  const listeners = new Set<Listener>()

  function commit(next: ReadonlySet<string>) {
    on = next
    try {
      storage?.setItem(storageKey, JSON.stringify([...next]))
    } catch {
      // The choice still holds until the app closes.
    }
    listeners.forEach((listener) => listener())
  }

  return {
    get: (key: string) => on.has(key),
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(key: string, value: boolean) {
      if (on.has(key) === value) return
      const next = new Set(on)
      if (value) next.add(key)
      else next.delete(key)
      commit(next)
    },
    // A draft conversation that becomes a real one keeps its choice.
    move(from: string, to: string) {
      if (!on.has(from) || from === to) return
      const next = new Set(on)
      next.delete(from)
      next.add(to)
      commit(next)
    },
  }
}

function read(storage?: UltraStorage): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(storageKey) ?? "[]")
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((key): key is string => typeof key === "string")
        : []
    )
  } catch {
    return new Set()
  }
}

export const conversationUltra = createConversationUltraStore(
  typeof localStorage === "undefined" ? undefined : localStorage
)
