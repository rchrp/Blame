import * as React from "react"
import type { NewProjectPlanMessage } from "@blame/agent-runtime"
import type { useModelSelection } from "@/components/model/model-selection"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { parseNewProjectConfiguration } from "./new-project-options"

type Message = NewProjectPlanMessage & {
  id: string
  error?: string
  context?: string
  attachments?: string[]
}
type Thread = { messages: Message[]; notes?: string }
type Pending = {
  sessionId: string
  messageId: string
  abort: () => Promise<unknown>
}

export function useNewProjectPlanning(input: {
  open: boolean
  projectName: string
  parentPath: string
  selection: ReturnType<typeof useModelSelection>
}) {
  const platform = usePlatform()
  const auth = useCloudAuth()
  const [thread, setThread] = React.useState<Thread>({ messages: [] })
  const threadRef = React.useRef(thread)
  const [pending, setPending] = React.useState(false)
  const pendingRef = React.useRef<Pending | undefined>(undefined)
  const unavailableReason = !platform.agent?.newProjects.plan
    ? "Project guidance runs in the Blame desktop app."
    : auth.status !== "authenticated"
      ? "Sign in to describe your project to the agent."
      : !input.selection.currentModel
        ? "Choose an AI model below to get started."
        : undefined

  const update = React.useCallback((next: Thread) => {
    threadRef.current = next
    setThread(next)
  }, [])

  const stop = React.useCallback(() => {
    const current = pendingRef.current
    if (!current) return
    pendingRef.current = undefined
    setPending(false)
    update({
      ...threadRef.current,
      messages: threadRef.current.messages.map((message) =>
        message.id === current.messageId
          ? {
              ...message,
              error: "You stopped the agent. Retry or send a new message.",
            }
          : message
      ),
    })
    void current.abort().catch(() => undefined)
  }, [update])

  const reset = React.useCallback(() => {
    stop()
    update({ messages: [] })
  }, [stop, update])

  // A changed destination or a closed wizard starts a fresh conversation.
  React.useEffect(() => {
    reset()
  }, [input.open, input.parentPath, input.projectName, reset])
  React.useEffect(
    () => () => {
      const current = pendingRef.current
      pendingRef.current = undefined
      void current?.abort().catch(() => undefined)
    },
    []
  )

  async function runTurn(messages: Message[], messageId: string) {
    const agent = platform.agent
    const model = input.selection.currentModel
    if (!agent || !model || unavailableReason || pendingRef.current) return
    const sessionId = `project_plan_${crypto.randomUUID()}`
    pendingRef.current = {
      sessionId,
      messageId,
      abort: () => agent.sessions.abort(sessionId),
    }
    setPending(true)
    const current = () => pendingRef.current?.sessionId === sessionId
    try {
      const result = await agent.newProjects.plan({
        apiConnection: auth.apiConnection,
        providerId: model.provider.id,
        modelId: model.id,
        credentialLabel: model.credentialLabel,
        reasoningEffort: input.selection.currentVariant,
        cwd: input.parentPath.trim(),
        workspaceRoot: input.parentPath.trim(),
        projectName: input.projectName.trim(),
        sessionId,
        messages: messages.map(({ role, text, configuration, context }) => ({
          role,
          text: context ? `${text}\n\n${context}` : text,
          configuration,
        })),
        notes: threadRef.current.notes,
      })
      if (!current()) return
      const configuration = result.configuration
        ? parseNewProjectConfiguration(result.configuration)
        : undefined
      update({
        messages: [
          ...threadRef.current.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: result.message,
            configuration,
          },
        ],
        notes: result.notes ?? threadRef.current.notes,
      })
    } catch (error) {
      if (!current()) return
      update({
        ...threadRef.current,
        messages: threadRef.current.messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                error:
                  error instanceof Error
                    ? error.message
                    : "The agent could not reply. Please retry.",
              }
            : message
        ),
      })
    } finally {
      if (current()) {
        pendingRef.current = undefined
        setPending(false)
      }
    }
  }

  function send(
    text: string,
    extra: Pick<Message, "context" | "attachments"> = {}
  ) {
    if (!text.trim() || pendingRef.current || unavailableReason) return false
    const message: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text: text.trim(),
      ...extra,
    }
    const messages = [...threadRef.current.messages, message]
    update({ ...threadRef.current, messages })
    void runTurn(messages, message.id)
    return true
  }

  function retry(messageId: string) {
    if (pendingRef.current || unavailableReason) return
    const index = threadRef.current.messages.findIndex(
      (message) => message.id === messageId && message.error
    )
    if (index < 0) return
    const messages = threadRef.current.messages
      .slice(0, index + 1)
      .map((message) => ({ ...message, error: undefined }))
    update({
      messages,
      notes:
        index === threadRef.current.messages.length - 1
          ? threadRef.current.notes
          : undefined,
    })
    void runTurn(messages, messageId)
  }

  const latest = thread.messages.at(-1)
  return {
    messages: thread.messages,
    proposal:
      !pending && latest?.role === "assistant"
        ? latest.configuration
        : undefined,
    pending,
    unavailableReason,
    send,
    retry,
    stop,
    reset,
  }
}
