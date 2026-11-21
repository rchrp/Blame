import * as React from "react"

import { conversationUltra } from "@/lib/conversation-ultra"

// Whether ultra mode is on for a conversation's next message, and how to
// change it. Without a key (no conversation to belong to) it is off.
export function useConversationUltra(key: string | undefined) {
  const on = React.useSyncExternalStore(
    conversationUltra.subscribe,
    () => (key ? conversationUltra.get(key) : false),
    () => false
  )
  const setOn = React.useCallback(
    (next: boolean) => {
      if (key) conversationUltra.set(key, next)
    },
    [key]
  )
  return [on, setOn] as const
}
