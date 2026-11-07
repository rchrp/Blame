import * as React from "react"

import { registeredAgentEventSubscription } from "@/components/backlog/data/agent-event-stream"
import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import { storyMaxInputTokens } from "@/components/backlog/data/story-context-limit"
import {
  projectPreviewConfiguration,
  projectRunConfigurationPreviewKey,
} from "@/components/backlog/board/project-run-configuration"
import type { PendingCodeSelectionAttachment } from "@/components/backlog/shared/comment-attachment-events"
import { nextCheckpointRunCount } from "@/components/chat/agent-run-checkpoints"
import { quickChatAgentRunning } from "@/components/chat/data/quick-chat-agent-control"
import {
  quickChatClineLogPath,
  quickChatClineLogRelativePath,
  recoverableQuickChatAgentRun,
} from "@/components/chat/data/quick-chat-agent-flow"
import type {
  QuickChat,
  QuickChatAgentRun,
  QuickChatMessage,
  QuickChatMessageDraft,
} from "@/components/chat/data/quick-chat-data"
import {
  interruptedQuickChatRunFinalization,
  agentTurnRecovery,
} from "@/components/chat/data/quick-chat-run-recovery"
import { useQuickChatStore } from "@/components/chat/data/quick-chat-store"
import { useModelSelection } from "@/components/model/model-selection"
import { useProjectInitialization } from "@/components/project-initialization/use-project-initialization"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { projectCodePractices } from "@/lib/project-code-practices"
import { chatPersonalization } from "@/lib/agent-personalization"
import { chatAmbitionKey, conversationAmbitions, newChatAmbitionKey } from "@/lib/conversation-ambition"
import { useLatestCallback } from "@/lib/use-latest-callback"
import {
  onQueuedDeliveryRequest,
  useAllQueuedComments,
} from "@/pages/backlog/comment-queue"
import {
  chatWithMessage,
  errorMessage,
  quickChatDevelopmentSummary,
  type QuickChatPromptInput,
  quickChatSendInput,
  quickChatSendValidationError,
  quickChatTitle,
  reportAgentPersistenceError,
  showQuickChatError,
} from "./quick-chat-helpers"
import {
  quickChatBackgroundWork,
  quickChatsReadyForQueuedMessages,
} from "./quick-chat-background"
import { QuickChatQueueDelivery } from "./quick-chat-queue-delivery"
import { quickChatQueueChatId } from "./use-quick-chat-queue"
import { useQuickChatAgentStream } from "./use-quick-chat-agent-stream"
import { useQuickChatSnapshotReplay } from "./use-quick-chat-snapshot-replay"

const agentCompletionRecoveryIntervalMs = 10_000

type QuickChatAgentRunnerValue = ReturnType<typeof useQuickChatAgentRunnerValue>

const QuickChatAgentRunnerContext = React.createContext<
  QuickChatAgentRunnerValue | undefined
>(undefined)

// Runs quick chat agents for the whole app, like the backlog page does for
// stories: wherever the person is, a chat keeps recording what its agent
// streams, picks up running turns after a restart, closes the turns that
// ended, and sends the messages queued while its agent worked.
export function QuickChatAgentRunner({
  children,
}: {
  children: React.ReactNode
}) {
  const value = useQuickChatAgentRunnerValue()
  return (
    <QuickChatAgentRunnerContext.Provider value={value}>
      {children}
    </QuickChatAgentRunnerContext.Provider>
  )
}

export function useQuickChatAgentRunner() {
  const context = React.useContext(QuickChatAgentRunnerContext)
  if (!context)
    throw new Error(
      "useQuickChatAgentRunner must be used within QuickChatAgentRunner"
    )
  return context
}

function useQuickChatAgentRunnerValue() {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const projects = useProjects()
  const projectInitialization = useProjectInitialization()
  const quickChats = useQuickChatStore()
  const selection = useModelSelection({ role: "agent" })
  const project = projects.activeProject
  const previewConfiguration = projectPreviewConfiguration(
    projectInitialization?.initialization?.runConfigurations ?? []
  )
  const chatsRef = React.useRef(quickChats.chats)
  const quickChatsRef = React.useRef(quickChats)
  const detailRequests = React.useRef(new Set<string>())
  const recoveringAgentRunIds = React.useRef(new Set<string>())
  const [delivery] = React.useState(() => new QuickChatQueueDelivery())
  const queuedComments = useAllQueuedComments()
  const stream = useQuickChatAgentStream({ chatsRef, platform, quickChatsRef })

  React.useEffect(() => {
    chatsRef.current = quickChats.chats
    quickChatsRef.current = quickChats
  }, [quickChats])

  useQuickChatSnapshotReplay({
    chatsRef,
    clearStream: stream.clearStream,
    loading: quickChats.loading,
    projectId: quickChats.projectId,
    quickChatsRef,
  })

  // Follow every running turn, including chats nobody opened since the app
  // started: their runs are only known once their details are loaded.
  const resumeStreams = useLatestCallback((chats: QuickChat[]) => {
    const store = quickChatsRef.current
    const work = quickChatBackgroundWork(chats, {
      busy: store.busyChatIds,
      detailsLoaded: store.chatDetailsLoaded,
      followed: registeredAgentEventSubscription,
    })
    work.load.forEach(loadRunningChat)
    for (const { chat, run, sessionId } of work.follow)
      stream.subscribe(chat, run, sessionId)
  })

  React.useEffect(() => {
    if (!platform.agent || quickChats.loading) return
    resumeStreams(quickChats.chats)
  }, [platform.agent, quickChats.chats, quickChats.loading, resumeStreams])

  function loadRunningChat(chat: QuickChat) {
    if (detailRequests.current.has(chat.id)) return
    detailRequests.current.add(chat.id)
    void quickChatsRef.current
      .loadDetail(chat)
      .catch(reportAgentPersistenceError)
      .finally(() => detailRequests.current.delete(chat.id))
  }

  const recoverRuns = useLatestCallback(async () => {
    const workspace = platform.workspace
    if (!workspace) return
    for (const listed of chatsRef.current) {
      if (listed.agentStatus !== "Running" || !listed.workspace) continue
      if (!quickChatsRef.current.chatDetailsLoaded(listed)) {
        loadRunningChat(listed)
        continue
      }
      await recoverRun(stream.currentChat(listed), workspace).catch(
        reportAgentPersistenceError
      )
    }
  })

  async function recoverRun(
    chat: QuickChat,
    workspace: NonNullable<typeof platform.workspace>
  ) {
    if (quickChatsRef.current.busyChatIds.has(chat.id)) return
    const run = recoverableQuickChatAgentRun(chat)
    const sessionId = run?.clineSessionId ?? chat.clineSessionId
    if (!run || !chat.workspace || !sessionId) return
    if (recoveringAgentRunIds.current.has(run.id)) return
    recoveringAgentRunIds.current.add(run.id)
    try {
      const recovery = await agentTurnRecovery(chat, run, sessionId, {
        live: platform.agent?.sessions.live,
        log: (id) =>
          workspace.readFile({
            root: chat.workspace!,
            path: quickChatClineLogRelativePath(id),
          }),
        messages: (id) =>
          platform.agent?.sessions.messages(id) ?? Promise.resolve(undefined),
      })
      if (recovery?.kind === "completed")
        await stream.persistAgentEvent(
          stream.currentChat(chat),
          run,
          recovery.event
        )
      if (recovery?.kind === "interrupted")
        stream.replaceChatRef(
          await quickChatsRef.current.finalizeAgentRun(
            stream.currentChat(chat),
            run,
            interruptedQuickChatRunFinalization(chat, run)
          )
        )
    } finally {
      recoveringAgentRunIds.current.delete(run.id)
    }
  }

  React.useEffect(() => {
    if (!platform.workspace || quickChats.loading) return
    void recoverRuns()
    const timer = window.setInterval(
      () => void recoverRuns(),
      agentCompletionRecoveryIntervalMs
    )
    return () => window.clearInterval(timer)
  }, [platform.workspace, quickChats.loading, recoverRuns])

  // Messages queued in a chat go out when its agent finishes, whether or not
  // the chat is open. "Send now" stops the agent first.
  const deliverQueued = useLatestCallback(
    async (chatId: string, commentId?: string) => {
      const chat = chatsRef.current.find((item) => item.id === chatId)
      if (!chat) return
      const running = quickChatAgentRunning(stream.currentChat(chat))
      try {
        await delivery.deliver({
          automatic: !commentId,
          chatId,
          commentId,
          send: sendQueuedMessage,
          stop:
            commentId && running
              ? () => quickChatsRef.current.stopAgent(stream.currentChat(chat))
              : undefined,
        })
      } catch (error) {
        showQuickChatError(
          "Couldn't send your queued message",
          errorMessage(error)
        )
      }
    }
  )

  React.useEffect(() => {
    const waiting = queuedComments
      .map((comment) => quickChatQueueChatId(comment.storyId))
      .filter((chatId): chatId is string => Boolean(chatId))
    for (const chatId of quickChatsReadyForQueuedMessages(
      quickChats.chats,
      waiting,
      quickChats.busyChatIds
    ))
      void deliverQueued(chatId)
  }, [deliverQueued, queuedComments, quickChats.busyChatIds, quickChats.chats])

  React.useEffect(
    () =>
      onQueuedDeliveryRequest((key, commentId) => {
        const chatId = quickChatQueueChatId(key)
        if (chatId) void deliverQueued(chatId, commentId)
      }),
    [deliverQueued]
  )

  async function sendQueuedMessage(
    chatId: string,
    queued: QuickChatMessageDraft
  ) {
    const conversation = chatsRef.current.find((item) => item.id === chatId)
    if (!conversation) throw new Error("Quick chat is no longer available.")
    const validationError = sendValidationError()
    if (validationError) throw new Error(validationError)
    await sendMessage(conversation, queued)
  }

  function sendValidationError() {
    return quickChatSendValidationError({
      auth,
      model: selection.currentModel,
      platform,
      projectPath: project?.path,
    })
  }

  // Adds the message to the chat and starts its agent on it. Resolves once
  // the turn has started; the response is followed in the background.
  async function sendMessage(
    conversation: QuickChat,
    input: QuickChatMessageDraft,
    onMessageCreated?: () => void
  ) {
    await quickChatsRef.current.agentOperations.start(
      conversation.id,
      async () => {
        const chat = stream.currentChat(await detailedChat(conversation))
        const message = await quickChatsRef.current.createMessage(chat, input)
        onMessageCreated?.()
        stream.replaceChatRef(
          chatWithMessage(stream.currentChat(chat), message)
        )
        await runAgentForMessage(
          chat,
          message,
          input.codeSelectionAttachments ?? [],
          input.fileAttachments ?? []
        )
      }
    )
  }

  async function detailedChat(conversation: QuickChat) {
    if (quickChatsRef.current.chatDetailsLoaded(conversation))
      return stream.currentChat(conversation)
    const chat = await quickChatsRef.current.loadDetail(conversation)
    stream.replaceChatRef(chat)
    return chat
  }

  async function runAgentForMessage(
    chat: QuickChat,
    message: QuickChatMessage,
    codeAttachments: PendingCodeSelectionAttachment[],
    fileAttachments: UserStoryFileAttachment[]
  ) {
    const executionId = crypto.randomUUID()
    const run = await quickChatsRef.current.createAgentRun(chat, {
      checkpointRunCount: nextCheckpointRunCount(chat.agentRuns ?? []),
      executionId,
      kind: chat.clineSessionId ? "change-request" : "resume",
      messageId: message.id,
    })
    try {
      await startAgentSession(chat, run, message, {
        codeAttachments,
        executionId,
        fileAttachments,
      })
    } catch (error) {
      await markAgentRunFailed(chat, run, error)
      throw error
    }
  }

  async function startAgentSession(
    chat: QuickChat,
    run: QuickChatAgentRun,
    message: QuickChatMessage,
    input: {
      codeAttachments: PendingCodeSelectionAttachment[]
      executionId: string
      fileAttachments: UserStoryFileAttachment[]
    }
  ) {
    const store = quickChatsRef.current
    const model = selection.currentModel!
    const workspace = project!.path
    const resumeSessionId = chat.clineSessionId
    const title = quickChatTitle(chat, message.body, project?.name)
    const summary = quickChatDevelopmentSummary(chat, message.body)
    // The ambition chosen before the chat existed now belongs to it.
    if (!resumeSessionId)
      conversationAmbitions.move(newChatAmbitionKey, chatAmbitionKey(chat.id))
    const session = await platform.agent!.sessions.startDevelopment({
      apiConnection: auth.apiConnection,
      providerId: model.provider.id,
      modelId: model.id,
      credentialLabel: model.credentialLabel,
      reasoningEffort: selection.currentVariant,
      // The cap picked in the chat's stats panel, like a story's.
      maxInputTokens: storyMaxInputTokens(
        chat.id,
        model,
        selection.allProviders
      ),
      autoSendPrompt: false,
      title,
      summary,
      codeSelectionAttachments: input.codeAttachments,
      fileAttachments: input.fileAttachments,
      cwd: workspace,
      resumeSessionId,
      workspaceRoot: workspace,
      previewDevtoolsScope: projectRunConfigurationPreviewKey(
        previewConfiguration,
        workspace
      ),
      codePractices: await projectCodePractices(auth, projects),
      executionId: input.executionId,
      personalization: chatPersonalization(chat.id),
      projectId: project!.id,
    })
    const reusedSession = Boolean(
      resumeSessionId && session.sessionId === resumeSessionId
    )
    const activeRun = await store.updateAgentRun(chat, run, {
      clineSessionId: session.sessionId,
    })
    const updatedChat = await store.update(stream.currentChat(chat), {
      agentActivities: [],
      agentFinalResponse: null,
      agentLastError: null,
      agentLastEvent: `Cline debug log: ${quickChatClineLogPath(
        workspace,
        session.sessionId
      )}`,
      agentModelId: model.id,
      agentProviderId: model.provider.id,
      agentStatus: "Running",
      agentUsage: null,
      clineSessionId: session.sessionId,
      title,
      workspace,
    })
    stream.replaceChatRef(updatedChat)
    stream.subscribe(updatedChat, activeRun, session.sessionId)
    // sendDevelopment resolves when the whole response ends. Only session
    // startup belongs to the submission; keep the composer live during it.
    void sendPrompt({
      chat: updatedChat,
      codeAttachments: input.codeAttachments,
      executionId: input.executionId,
      fileAttachments: input.fileAttachments,
      message,
      reusedSession,
      run: activeRun,
      sessionId: session.sessionId,
      summary,
      title,
    }).catch(reportAgentPersistenceError)
  }

  async function sendPrompt(input: QuickChatPromptInput) {
    const coordinator = stream.coordinator(input.sessionId)
    try {
      await platform.agent!.sessions.sendDevelopment({
        ...quickChatSendInput(input),
        personalization: chatPersonalization(input.chat.id),
      })
    } catch (error) {
      await stream.terminateWithError(
        input.sessionId,
        coordinator,
        errorMessage(error)
      )
    }
  }

  async function markAgentRunFailed(
    chat: QuickChat,
    run: QuickChatAgentRun,
    error: unknown
  ) {
    const store = quickChatsRef.current
    const message = errorMessage(error)
    const chatInput = {
      agentLastError: message,
      agentLastEvent: message,
      agentStatus: null,
    }
    const runInput = {
      completedAt: new Date().toISOString(),
      finalResponse: message,
      status: "failed" as const,
    }
    stream.updateChatLocal(chat, chatInput)
    store.updateAgentRunLocal(chat, run, runInput)
    await Promise.all([
      store.update(chat, chatInput).catch(() => undefined),
      store.updateAgentRun(chat, run, runInput).catch(() => undefined),
    ])
  }

  return {
    currentChat: stream.currentChat,
    detailedChat,
    rememberChat: stream.replaceChatRef,
    sendMessage,
    sendValidationError,
  }
}
