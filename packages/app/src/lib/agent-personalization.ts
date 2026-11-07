import {
  chatAmbitionKey,
  conversationAmbitions,
} from "./conversation-ambition.ts"
import { personalizationStore } from "./personalization-store.ts"
import {
  agentPersonalization,
  type Ambition,
  type Personalization,
} from "./personalization.ts"

// What an agent turn is told, read as the turn starts: a change made while a
// turn runs reaches the next one.
export function currentPersonalization(
  ambition?: Ambition | null
): Personalization {
  return agentPersonalization(personalizationStore.get(), ambition)
}

export function chatPersonalization(chatId: string) {
  return currentPersonalization(conversationAmbitions.get(chatAmbitionKey(chatId)))
}

export function conversationPersonalization(ambitionKey?: string) {
  return currentPersonalization(
    ambitionKey ? conversationAmbitions.get(ambitionKey) : null
  )
}
