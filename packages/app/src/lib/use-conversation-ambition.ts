import * as React from "react"

import { conversationAmbitions } from "@/lib/conversation-ambition"

// The ambition chosen for a conversation, and how to change it.
export function useConversationAmbition(key: string) {
  const subscribe = conversationAmbitions.subscribe
  const ambition = React.useSyncExternalStore(
    subscribe,
    () => conversationAmbitions.get(key),
    () => conversationAmbitions.get(key)
  )
  const setAmbition = React.useCallback(
    (next: Parameters<typeof conversationAmbitions.set>[1]) =>
      conversationAmbitions.set(key, next),
    [key]
  )
  return [ambition, setAmbition] as const
}
