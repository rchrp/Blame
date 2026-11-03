import * as React from "react"
import type { AgentConversationPurpose, AgentEvent } from "@blame/agent-runtime"

import { terminalAgentRunEvent } from "@/components/backlog/data/agent-flow"
import { subscribeAgentEvents } from "@/components/backlog/data/agent-event-stream"
import { AgentStreamCoordinator } from "@/components/backlog/data/agent-stream-coordinator"
import type {
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import type { AgentConversationRun } from "@/components/chat/agent-conversation"
import type { useModelSelection } from "@/components/model/model-selection"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"

import {
  appendTurn,
  applyStreamSnapshot,
  emptyLocalConversation,
  endRun,
  loadLocalConversation,
  saveLocalConversation,
  updateRun,
  type LocalAgentConversation,
} from "./data/local-agent-conversation-data"

export type LocalAgentMessage = {
  text: string
  codeSelectionAttachments?: UserStoryCodeSelectionAttachment[]
  fileAttachments?: UserStoryFileAttachment[]
  // Read by the agent with the message, never shown in the thread.
  context?: string
}

type Stream = { close(): void; runId: string; sessionId?: string }

/**
 * A conversation the app keeps itself (plan mode, the new-project
 * assistant) that runs on the same agent harness as chats and user stories:
 * one runtime session, resumed on every turn, and the same timeline.
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
  const [conversation, setConversationState] = React.useState(() =>
    loadLocalConversation(input.storageKey)
  )
  const conversationRef = React.useRef(conversation)
  const streamRef = React.useRef<Stream | undefined>(undefined)
  const storageKeyRef = React.useRef(input.storageKey)
  storageKeyRef.current = input.storageKey

  const setConversation = React.useCallback(
    (update: (current: LocalAgentConversation) => LocalAgentConversation) => {
      const next = update(conversationRef.current)
      conversationRef.current = next
      setConversationState(next)
      saveLocalConversation(storageKeyRef.current, next)
    },
    []
  )

  const closeStream = React.useCallback((runId?: string) => {
    const stream = streamRef.current
    if (!stream || (runId && stream.runId !== runId)) return undefined
    streamRef.current = undefined
    stream.close()
    return stream
  }, [])

  const stop = React.useCallback(() => {
    const stream = closeStream()
    if (!stream) return
    setConversation((current) =>
      endRun(current, stream.runId, "cancelled", "You stopped the agent.")
    )
    if (stream.sessionId)
      void platform.agent?.sessions.abort(stream.sessionId).catch(() => {})
  }, [closeStream, platform.agent, setConversation])

  const reset = React.useCallback(() => {
    stop()
    setConversation(() => emptyLocalConversation())
  }, [setConversation, stop])

  // A running turn does not outlive its surface.
  const stopRef = React.useRef(stop)
  stopRef.current = stop
  React.useEffect(() => () => stopRef.current(), [])

  function subscribe(runId: string, sessionId: string, executionId: string) {
    const coordinator = new AgentStreamCoordinator({
      executionId,
      initialState: { agentActivities: [] },
      persist: ({ event, update }) => {
        setConversation((current) =>
          applyStreamSnapshot(current, runId, update, event)
        )
        if (terminalAgentRunEvent(event))
          queueMicrotask(() => closeStream(runId))
      },
      runId,
      sessionId,
    })
    const unsubscribe = subscribeAgentEvents(
      platform,
      sessionId,
      (event) =>
        void (
          terminalAgentRunEvent(event)
            ? coordinator.terminate(event)
            : coordinator.push(event)
        ).catch(() => undefined),
      executionId
    )
    const close = () => {
      unsubscribe()
      void coordinator.disconnect().catch(() => undefined)
    }
    const stream = streamRef.current
    if (stream?.runId === runId) Object.assign(stream, { close, sessionId })
    else close()
    return (event: AgentEvent) => coordinator.terminate(event)
  }

  async function runTurn(runId: string, message: LocalAgentMessage) {
    const agent = platform.agent
    const model = input.selection.currentModel
    const cwd = input.cwd?.trim()
    const executionId = crypto.randomUUID()
    const current = () => streamRef.current?.runId === runId
    try {
      if (!agent || !model || !cwd) throw new Error("The agent is unavailable.")
      const session = await agent.sessions.startDevelopment({
        apiConnection: auth.apiConnection,
        autoSendPrompt: false,
        checkpointEnabled: false,
        credentialLabel: model.credentialLabel,
        cwd,
        executionId,
        modelId: model.id,
        projectId: input.projectId,
        providerId: model.provider.id,
        purpose: input.purpose,
        reasoningEffort: input.selection.currentVariant,
        resumeSessionId: conversationRef.current.sessionId ?? null,
        summary: message.text,
        title: input.title,
        workspaceRoot: cwd,
      })
      if (!current()) return
      setConversation((value) => ({
        ...updateRun(value, runId, { clineSessionId: session.sessionId }),
        sessionId: session.sessionId,
      }))
      const fail = subscribe(runId, session.sessionId, executionId)
      await agent.sessions
        .sendDevelopment({
          executionId,
          feedback: [message.text, message.context]
            .filter(Boolean)
            .join("\n\n"),
          feedbackCodeSelectionAttachments: message.codeSelectionAttachments,
          feedbackFileAttachments: message.fileAttachments,
          feedbackOnly: true,
          sessionId: session.sessionId,
          summary: message.text,
          title: input.title,
        })
        .catch((error: unknown) => {
          if (current())
            void fail({
              payload: { message: errorMessage(error) },
              sessionId: session.sessionId,
              type: "error",
            })
        })
    } catch (error) {
      if (!current()) return
      closeStream(runId)
      setConversation((value) =>
        endRun(value, runId, "failed", errorMessage(error))
      )
    }
  }

  function send(message: LocalAgentMessage) {
    const text = message.text.trim()
    if (!text || streamRef.current || input.unavailableReason) return false
    const model = input.selection.currentModel
    const now = new Date().toISOString()
    const commentId = crypto.randomUUID()
    const run: AgentConversationRun = {
      activities: [],
      createdAt: now,
      id: crypto.randomUUID(),
      kind: "change-request",
      messageId: commentId,
      modelId: model?.id,
      providerId: model?.provider.id,
      reasoningEffort: input.selection.currentVariant,
      status: "running",
    }
    streamRef.current = { close: () => undefined, runId: run.id }
    setConversation((current) =>
      appendTurn(
        current,
        {
          author: "You",
          body: text,
          codeSelectionAttachments: message.codeSelectionAttachments,
          createdAt: now,
          fileAttachments: message.fileAttachments,
          id: commentId,
        },
        run
      )
    )
    void runTurn(run.id, { ...message, text })
    return true
  }

  return {
    conversation,
    running: conversation.runs.some((run) => run.status === "running"),
    reset,
    send,
    stop,
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
