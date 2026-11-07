import type { Ambition } from "./personalization.ts"

type Listener = () => void

export type AmbitionStorage = Pick<Storage, "getItem" | "setItem">

const storageKey = "blame.conversation-ambition.v1"
const ambitions: readonly string[] = ["quick", "standard", "ambitious"]

// The new chat, before its first message gives it an identity.
export const newChatAmbitionKey = "chat:new"

export function chatAmbitionKey(chatId?: string) {
  return chatId ? `chat:${chatId}` : newChatAmbitionKey
}

export function planModeAmbitionKey(projectId?: string) {
  return `plan-mode:${projectId ?? "none"}`
}

// The ambition chosen for a chat or a planning conversation, which holds for
// the whole conversation. A conversation without one follows the account's.
export function createConversationAmbitionStore(storage?: AmbitionStorage) {
  let overrides = read(storage)
  const listeners = new Set<Listener>()

  function commit(next: Record<string, Ambition>) {
    overrides = next
    try {
      storage?.setItem(storageKey, JSON.stringify(next))
    } catch {
      // The choice still holds until the app closes.
    }
    listeners.forEach((listener) => listener())
  }

  return {
    get: (key: string): Ambition | null => overrides[key] ?? null,
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(key: string, ambition: Ambition | null) {
      if ((overrides[key] ?? null) === ambition) return
      const { [key]: _removed, ...rest } = overrides
      void _removed
      commit(ambition ? { ...rest, [key]: ambition } : rest)
    },
    // A draft conversation that becomes a real one keeps its choice.
    move(from: string, to: string) {
      const ambition = overrides[from]
      if (!ambition || from === to) return
      const { [from]: _removed, ...rest } = overrides
      void _removed
      commit({ ...rest, [to]: ambition })
    },
  }
}

function read(storage?: AmbitionStorage): Record<string, Ambition> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(storageKey) ?? "{}")
    if (typeof parsed !== "object" || parsed === null) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, Ambition] =>
          typeof entry[1] === "string" && ambitions.includes(entry[1])
      )
    )
  } catch {
    return {}
  }
}

export const conversationAmbitions = createConversationAmbitionStore(
  typeof localStorage === "undefined" ? undefined : localStorage
)
