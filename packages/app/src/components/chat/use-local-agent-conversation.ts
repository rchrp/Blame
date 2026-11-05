import * as React from "react"
import type { AgentConversationPurpose } from "@blame/agent-runtime"

import type { useModelSelection } from "@/components/model/model-selection"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"

import {
  LocalAgentConversationSession,
  sharedLocalAgentConversation,
  type LocalAgentMessage,
} from "./local-agent-conversation-session"

export type { LocalAgentMessage } from "./local-agent-conversation-session"

/**
 * A conversation the app keeps itself (plan mode, the new-project
 * assistant) that runs on the same agent harness as chats and user stories:
 * one runtime session, resumed on every turn, and the same timeline.
 *
 * A kept conversation (with a storage key) belongs to the app, not to this
 * view: its turn goes on while the view is closed or another project is
 * open. One kept in memory only ends its turn with the view.
 */
export function useLocalAgentConversation(input: {
  cwd?: string
  projectId?: string
  purpose: AgentConversationPurpose
  selection: ReturnType<typeof useModelSelection>
  // Where the conversation is kept; unset keeps it in memory only.
  storageKey?: string
  title: string
  unavailableReason?: string
}) {
  const platform = usePlatform()
  const auth = useCloudAuth()
  const [owned] = React.useState(() => new LocalAgentConversationSession())
  const session = input.storageKey
    ? sharedLocalAgentConversation(input.storageKey)
    : owned
  const conversation = React.useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot
  )

  React.useEffect(() => () => owned.stop(), [owned])

  React.useEffect(() => {
    if (input.storageKey) void session.resume(platform, input.cwd)
  }, [input.cwd, input.storageKey, platform, session])

  function send(message: LocalAgentMessage) {
    return session.send(message, {
      apiConnection: auth.apiConnection,
      cwd: input.cwd,
      model: input.selection.currentModel,
      platform,
      projectId: input.projectId,
      purpose: input.purpose,
      reasoningEffort: input.selection.currentVariant,
      title: input.title,
      unavailableReason: input.unavailableReason,
    })
  }

  return {
    conversation,
    running: conversation.runs.some((run) => run.status === "running"),
    reset: () => session.reset(),
    send,
    stop: () => session.stop(),
  }
}
