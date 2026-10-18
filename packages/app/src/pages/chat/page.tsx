import * as React from "react"
import { createDebouncedUpdateQueue } from "@/lib/debounced-update-queue"
import type { AgentEvent } from "@blame/agent-runtime"
import { QuickChatEmptyState } from "@/components/chat/quick-chat-empty-state"
import { toast } from "sonner"

import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import {
  agentEventText,
  completedAgentRun,
  shouldPersistAgentEvent,
  terminalAgentRunEvent,
} from "@/components/backlog/data/agent-flow"
import {
  registeredAgentEventSubscription,
  subscribeAgentEvents,
} from "@/components/backlog/data/agent-event-stream"
import {
  agentPersistenceEvent,
  AgentStreamCoordinator,
  type AgentStreamSnapshotPersistence,
} from "@/components/backlog/data/agent-stream-coordinator"
import { agentStreamStore } from "@/components/backlog/data/agent-stream-store"
import {
  pendingAgentRunSnapshots,
  persistAgentSnapshot,
} from "@/components/backlog/data/agent-snapshot-outbox"
import type { PendingCodeSelectionAttachment } from "@/components/backlog/shared/comment-attachment-events"
import { pendingFileAttachments } from "@/components/backlog/drawer/user-story-attachment-files"
import {
  projectPreviewConfiguration,
  projectRunConfigurationPreviewKey,
} from "@/components/backlog/board/project-run-configuration"
import { ProjectRunConfigurationPreviewWarmup } from "@/components/backlog/board/project-run-preview-warmup"
import {
  AgentConversationComposer,
  AgentConversationTimeline,
  type AgentConversationUserMessageUndo,
} from "@/components/chat/agent-conversation"
import {
  captureAgentRunDiffEndRef,
  loadAgentRunDiffs,
  loadAgentRunDiffSummary,
} from "@/components/chat/agent-run-diffs"
import { nextCheckpointRunCount } from "@/components/chat/agent-run-checkpoints"
import {
  latestLinkedAgentTurn,
  useAgentTurnMetrics,
} from "@/components/chat/agent-turn-metrics"
import {
  completedQuickChatClineLog,
  definedQuickChatUpdate,
  immediateQuickChatAgentEvent,
  pendingQuickChatAgentUpdate,
  quickChatAgentEventUpdate,
  quickChatAgentMetadataUpdate,
  quickChatAgentRunEventUpdate,
  quickChatAgentRunMetadataUpdate,
  quickChatClineLogPath,
  quickChatClineLogRelativePath,
  quickChatExpiredAuthenticationToken,
  recoverableQuickChatAgentRun,
  type QueuedQuickChatAgentUpdate,
} from "@/components/chat/data/quick-chat-agent-flow"
import {
  type QuickChat,
  type QuickChatAgentRun,
  type QuickChatAgentRunFinalization,
  type QuickChatAgentRunUpdate,
  type QuickChatMessage,
  type QuickChatUpdate,
} from "@/components/chat/data/quick-chat-data"
import { useQuickChatStore } from "@/components/chat/data/quick-chat-store"
import { agentConversationResponseHeader } from "@/components/chat/agent-conversation-header"
import { composerDraftStorageKey } from "@/components/backlog/drawer/composer-draft-storage"
import { ModelSelector } from "@/components/model/model-selector"
import { useModelSelection } from "@/components/model/model-selection"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { useProjectInitialization } from "@/components/project-initialization/use-project-initialization"
import { projectCodePractices } from "@/lib/project-code-practices"
import { showSystemNotification } from "@/lib/system-notifications"
import { generateAgentTitle } from "@/lib/agent-title-generation"
import {
  chatWithMessage,
  errorMessage,
  openProjectPath,
  quickChatAgentFinalization,
  quickChatDevelopmentSummary,
  quickChatMessageBody,
  type QuickChatPromptInput,
  quickChatSendInput,
  quickChatSendValidationError,
  quickChatTerminalPersistenceEvent,
  quickChatTitle,
  reportAgentPersistenceError,
  restoreQuickChatCheckpoint,
  showExpiredAuthenticationToast,
  showQuickChatError,
  titleFromMessage,
} from "./quick-chat-helpers"
import { useQuickChatDraft } from "./use-quick-chat-draft"
import { useQuickChatSnapshotReplay } from "./use-quick-chat-snapshot-replay"
import { QuickChatStatus } from "./quick-chat-status"

const agentEventPersistDelayMs = 1_500
const agentCompletionRecoveryIntervalMs = 10_000
const stoppedAgentEvent = {
  payload: { reason: "aborted", text: "Agent stopped." },
  type: "done",
} satisfies AgentEvent
const bottomBlurMask = {
  maskImage: "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
  WebkitMaskImage:
    "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
} satisfies React.CSSProperties

type QuickChatDevelopmentSessionInput = {
  codeAttachments: PendingCodeSelectionAttachment[]
  executionId: string
  fileAttachments: UserStoryFileAttachment[]
  resumeSessionId?: string | null
  summary: string
  title: string
  workspace: string
}

export function ChatPage() {
  const projects = useProjects()
  const projectKey = projects.activeProject?.id ?? "project"

  return <QuickChatProjectPage key={projectKey} />
}

function QuickChatProjectPage() {
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
  const [sending, setSending] = React.useState(false)
  const [cancelingAgent, setCancelingAgent] = React.useState(false)
  const chatsRef = React.useRef(quickChats.chats)
  const quickChatsRef = React.useRef(quickChats)
  const pendingAgentUpdates = React.useRef(
    createDebouncedUpdateQueue<QueuedQuickChatAgentUpdate>(
      agentEventPersistDelayMs
    )
  )
  const agentEventUnsubscribers = React.useRef(new Map<string, () => void>())
  const agentStreamCoordinators = React.useRef(
    new Map<string, AgentStreamCoordinator>()
  )
  const resumeQuickChatStreamsRef = React.useRef<(chats: QuickChat[]) => void>(
    () => undefined
  )
  const recoveringAgentRunIds = React.useRef(new Set<string>())
  const recoverAgentEventRef = React.useRef<
    (
      chat: QuickChat,
      run: QuickChatAgentRun | undefined,
      event: AgentEvent
    ) => Promise<unknown>
  >(() => Promise.resolve())
  const activeConversation = quickChats.activeChat
  const draftStorageKey = composerDraftStorageKey(
    project?.id ?? "project",
    "chat",
    activeConversation?.id
  )
  const {
    clearDraft,
    draft,
    draftCodeAttachments,
    draftEditorKey,
    draftFileAttachments,
    draftHasContent,
    draftRef,
    setDraft,
    setDraftCodeAttachments,
    setDraftEditorKey,
    setDraftFileAttachments,
  } = useQuickChatDraft(draftStorageKey)
  const activeConversationLoaded =
    !activeConversation || quickChats.chatDetailsLoaded(activeConversation)
  const responseHeader = agentConversationResponseHeader({
    modelId: activeConversation?.agentModelId ?? selection.currentModel?.id,
    providerId:
      activeConversation?.agentProviderId ??
      selection.currentModel?.provider.id,
    providers: selection.allProviders,
  })
  const loadChangedFiles = React.useCallback(
    (sessionId: string, checkpointRunCount: number, diffEndRef: string) => {
      if (!activeConversation?.workspace) return Promise.resolve([])
      return loadAgentRunDiffSummary({
        checkpointRunCount,
        diffEndRef,
        platform,
        root: activeConversation.workspace,
        sessionId,
      })
    },
    [activeConversation?.workspace, platform]
  )
  const loadChangedFileDiffs = React.useCallback(
    (sessionId: string, checkpointRunCount: number, diffEndRef: string) => {
      if (!activeConversation?.workspace) return Promise.resolve([])
      return loadAgentRunDiffs({
        checkpointRunCount,
        diffEndRef,
        platform,
        root: activeConversation.workspace,
        sessionId,
      })
    },
    [activeConversation?.workspace, platform]
  )
  const mentionDirectory = project?.path
  const agentRunning = activeConversation?.agentStatus === "Running"
  const latestTurn = latestLinkedAgentTurn(
    activeConversation?.messages ?? [],
    activeConversation?.agentRuns ?? [],
    (run) => run.messageId
  )
  const turnMetrics = useAgentTurnMetrics({
    root: activeConversation?.workspace,
    run: latestTurn?.run,
    startedAt: latestTurn?.message.createdAt,
  })
  React.useEffect(() => {
    chatsRef.current = quickChats.chats
    quickChatsRef.current = quickChats
  }, [quickChats])

  useQuickChatSnapshotReplay({
    chatsRef,
    clearStream: clearQuickChatAgentStream,
    loading: quickChats.loading,
    projectId: quickChats.projectId,
    quickChatsRef,
  })

  React.useEffect(() => {
    if (!activeConversation || quickChats.chatDetailsLoaded(activeConversation))
      return
    void quickChats.loadDetail(activeConversation).catch((error) => {
      showQuickChatError("Unable to load quick chat", errorMessage(error))
    })
  }, [activeConversation, quickChats])

  React.useEffect(() => {
    resumeQuickChatStreamsRef.current = (chats) => {
      chats.forEach((chat) => {
        chat.agentRuns?.forEach((run) => {
          const sessionId = run.clineSessionId ?? chat.clineSessionId
          if (run.status !== "running" || !sessionId) return
          if (registeredAgentEventSubscription(sessionId)) return
          subscribeQuickChatAgentEvents(chat, run, sessionId)
        })
      })
    }
  })

  React.useEffect(() => {
    if (!platform.agent || quickChats.loading) return
    resumeQuickChatStreamsRef.current(quickChats.chats)
  }, [platform.agent, quickChats.chats, quickChats.loading])

  React.useEffect(() => {
    const updates = pendingAgentUpdates.current
    const unsubscribers = agentEventUnsubscribers.current
    const coordinators = agentStreamCoordinators.current
    return () => {
      updates.clear()
      unsubscribers.forEach((unsubscribe) => unsubscribe())
      unsubscribers.clear()
      coordinators.forEach((coordinator) => {
        void coordinator.disconnect().catch(reportAgentPersistenceError)
      })
      coordinators.clear()
    }
  }, [])

  React.useEffect(() => {
    if (!platform.workspace || !activeConversationLoaded || !activeConversation)
      return
    const recover = async () => {
      const current = currentChat(activeConversation)
      const run = recoverableQuickChatAgentRun(current)
      const workspace = platform.workspace
      const sessionId = run?.clineSessionId ?? current.clineSessionId
      if (!run || !workspace || !current.workspace || !sessionId) return
      if (recoveringAgentRunIds.current.has(run.id)) return
      recoveringAgentRunIds.current.add(run.id)
      try {
        const log = await workspace
          .readFile({
            root: current.workspace,
            path: quickChatClineLogRelativePath(sessionId),
          })
          .catch(() => "")
        if (!completedQuickChatClineLog(log)) return
        await recoverAgentEventRef.current(currentChat(current), run, {
          payload: {},
          type: "done",
        })
      } finally {
        recoveringAgentRunIds.current.delete(run.id)
      }
    }
    void recover()
    const timer = window.setInterval(recover, agentCompletionRecoveryIntervalMs)
    return () => window.clearInterval(timer)
  }, [activeConversation, activeConversationLoaded, platform.workspace])

  function replaceChatRef(chat: QuickChat) {
    const exists = chatsRef.current.some((item) => item.id === chat.id)
    chatsRef.current = exists
      ? chatsRef.current.map((item) => (item.id === chat.id ? chat : item))
      : [chat, ...chatsRef.current]
  }

  function currentChat(chat: QuickChat) {
    return chatsRef.current.find((item) => item.id === chat.id) ?? chat
  }

  function updateChatLocal(chat: QuickChat, input: QuickChatUpdate) {
    const current = currentChat(chat)
    const next = { ...current, ...definedQuickChatUpdate(input) } as QuickChat
    replaceChatRef(next)
    quickChats.updateLocal(current, input)
    return next
  }

  async function persistQueuedAgentUpdate(
    chat: QuickChat,
    update: QueuedQuickChatAgentUpdate
  ) {
    let nextChat = currentChat(chat)
    const finalization = quickChatAgentFinalization(update)
    if (update.run && finalization) {
      const event =
        finalization.persistenceEvent ??
        quickChatTerminalPersistenceEvent(nextChat, update.run, finalization)
      finalization.persistenceEvent = event
      const finalized = await persistAgentSnapshot(
        window.localStorage,
        {
          event,
          messageId: update.activities.at(-1)?.id ?? "message-final",
          projectId: nextChat.projectId,
          runId: update.run.id,
          targetId: nextChat.id,
          targetType: "quick-chat",
          update: finalization,
        },
        (snapshot) =>
          quickChats.finalizeAgentRun(
            nextChat,
            update.run!,
            snapshot.update as QuickChatAgentRunFinalization
          )
      )
      replaceChatRef(finalized)
      return finalized
    }
    const metadata = quickChatAgentMetadataUpdate(update.input)
    if (Object.keys(definedQuickChatUpdate(metadata)).length) {
      nextChat = await quickChats.update(nextChat, metadata)
      replaceChatRef(nextChat)
    }
    if (update.activities.length) {
      if (update.run) {
        await quickChats.updateAgentRun(nextChat, update.run, {
          agentActivityUpdates: update.activities,
        })
      } else {
        nextChat = await quickChats.update(currentChat(nextChat), {
          agentActivityUpdates: update.activities,
        })
        replaceChatRef(nextChat)
      }
    }
    if (update.run) await persistAgentRunMetadata(nextChat, update)
    return nextChat
  }

  async function persistAgentRunMetadata(
    chat: QuickChat,
    update: QueuedQuickChatAgentUpdate
  ) {
    if (!update.run) return
    const metadata = quickChatAgentRunMetadataUpdate(update.runInput)
    if (!Object.keys(definedQuickChatUpdate(metadata)).length) return
    await quickChats.updateAgentRun(chat, update.run, metadata)
  }

  function queueAgentUpdate(
    chat: QuickChat,
    run: QuickChatAgentRun | undefined,
    input: QuickChatUpdate,
    runInput: QuickChatAgentRunUpdate
  ) {
    const pending = pendingAgentUpdates.current.get(chat.id)
    const update = pendingQuickChatAgentUpdate(pending, input, run, runInput)
    pendingAgentUpdates.current.schedule(chat.id, update, (queued) => {
      void persistQueuedAgentUpdate(chat, queued).catch(
        reportAgentPersistenceError
      )
    })
  }

  function flushAgentUpdate(
    chat: QuickChat,
    run: QuickChatAgentRun | undefined,
    input: QuickChatUpdate,
    runInput: QuickChatAgentRunUpdate
  ) {
    const pending = pendingAgentUpdates.current.take(chat.id)
    return persistQueuedAgentUpdate(
      chat,
      pendingQuickChatAgentUpdate(pending, input, run, runInput)
    )
  }

  function persistAgentUpdate(
    chat: QuickChat,
    run: QuickChatAgentRun | undefined,
    input: QuickChatUpdate,
    runInput: QuickChatAgentRunUpdate,
    immediate: boolean
  ) {
    const nextChat = updateChatLocal(chat, input)
    if (run) quickChats.updateAgentRunLocal(nextChat, run, runInput)
    if (immediate) {
      return flushAgentUpdate(nextChat, run, input, runInput).catch((error) => {
        reportAgentPersistenceError(error)
        throw error
      })
    }
    queueAgentUpdate(nextChat, run, input, runInput)
    return Promise.resolve(nextChat)
  }

  async function persistAgentEvent(
    chat: QuickChat,
    run: QuickChatAgentRun | undefined,
    event: AgentEvent,
    prepared?: AgentStreamSnapshotPersistence
  ) {
    const current = currentChat(chat)
    const update = quickChatAgentEventUpdate(current, event, prepared?.update)
    if (!shouldPersistAgentEvent(event, update)) return
    const text = agentEventText(event)
    const runInput = quickChatAgentRunEventUpdate(update, event, text)
    if (run) {
      runInput.persistenceEvent =
        prepared?.persistenceEvent ??
        agentPersistenceEvent(event, {
          executionId: run.executionId ?? event.executionId ?? run.id,
          lastSequenceNumber: run.lastSequenceNumber,
          runId: run.id,
          sessionId:
            event.sessionId ??
            run.clineSessionId ??
            current.clineSessionId ??
            run.id,
        })
    }
    if (
      prepared &&
      run &&
      !terminalAgentRunEvent(event) &&
      !quickChatExpiredAuthenticationToken(text)
    ) {
      return persistQuickChatStreamSnapshot(current, run, runInput, prepared)
    }
    if (run && terminalAgentRunEvent(event) && !run.diffEndRef) {
      runInput.diffEndRef = await captureAgentRunDiffEndRef({
        id: run.id,
        platform,
        root: current.workspace,
      })
    }
    if (completedAgentRun(event)) notifyQuickChatResponseCompleted(current)
    return persistAgentUpdate(
      current,
      run,
      update,
      runInput,
      immediateQuickChatAgentEvent(event)
    )
  }

  function persistQuickChatStreamSnapshot(
    chat: QuickChat,
    run: QuickChatAgentRun,
    runInput: QuickChatAgentRunUpdate,
    prepared: AgentStreamSnapshotPersistence
  ) {
    return persistAgentSnapshot(
      window.localStorage,
      {
        event: prepared.persistenceEvent,
        messageId: prepared.update.agentActivity?.id ?? prepared.event.type,
        projectId: chat.projectId,
        runId: run.id,
        targetId: chat.id,
        targetType: "quick-chat",
        update: runInput,
      },
      (snapshot) =>
        quickChats.updateAgentRun(
          chat,
          run,
          snapshot.update as QuickChatAgentRunUpdate
        )
    )
  }

  React.useEffect(() => {
    recoverAgentEventRef.current = persistAgentEvent
  })

  function notifyQuickChatResponseCompleted(chat: QuickChat) {
    void showSystemNotification(platform, {
      body: chat.title,
      title: "Agent response ready",
    })
  }

  async function undoQuickChatMessage(
    target: AgentConversationUserMessageUndo
  ) {
    if (!activeConversation) return
    const current = await detailedConversation(activeConversation)
    await quickChats.validateMessageUndo(
      current,
      target.comment.id,
      target.run.id
    )
    const restored = await restoreQuickChatCheckpoint(
      platform,
      current,
      target.run.clineSessionId ?? current.clineSessionId,
      target.checkpointRunCount
    )
    const nextConversation = await quickChats.undoMessage(
      current,
      target.comment.id,
      { clineSessionId: restored.sessionId, runId: target.run.id }
    )
    replaceChatRef(nextConversation)
    setDraft(target.comment.body)
    setDraftCodeAttachments(target.comment.codeSelectionAttachments ?? [])
    setDraftFileAttachments(target.comment.fileAttachments ?? [])
    setDraftEditorKey((key) => key + 1)
    requestAnimationFrame(() => {
      draftRef.current
        ?.querySelector<HTMLElement>("[data-markdown-editor-input='true']")
        ?.focus()
    })
    toast.success("Message restored to editor.", { position: "bottom-right" })
  }

  function applySuggestion(prompt: string) {
    setDraft(prompt)
    setDraftEditorKey((key) => key + 1)
    requestAnimationFrame(() => {
      draftRef.current
        ?.querySelector<HTMLElement>("[data-markdown-editor-input='true']")
        ?.focus()
    })
  }

  async function submitDraft() {
    if (!draftHasContent() || sending) return
    const validationError = quickChatSendValidationError({
      auth,
      model: selection.currentModel,
      platform,
      projectPath: project?.path,
    })
    if (validationError) {
      showQuickChatError("Unable to send quick change", validationError)
      return
    }
    const messageBody = quickChatMessageBody(
      draft,
      draftCodeAttachments,
      draftFileAttachments
    )
    const codeAttachments = draftCodeAttachments
    const fileAttachments = draftFileAttachments
    setSending(true)
    try {
      const chat = await activeOrCreatedConversation(messageBody)
      const message = await quickChats.createMessage(chat, {
        body: messageBody,
        codeSelectionAttachments: codeAttachments,
        fileAttachments,
      })
      clearDraft()
      replaceChatRef(chatWithMessage(currentChat(chat), message))
      await runAgentForMessage(chat, message, codeAttachments, fileAttachments)
    } catch (error) {
      showQuickChatError("Quick chat failed", errorMessage(error))
    } finally {
      setSending(false)
    }
  }

  async function cancelAgent() {
    const conversation = activeConversation
      ? currentChat(activeConversation)
      : undefined
    const run = conversation?.agentRuns?.findLast(
      (currentRun) => currentRun.status === "running"
    )
    const sessionId = run?.clineSessionId ?? conversation?.clineSessionId
    if (
      !conversation ||
      !agentRunning ||
      !sessionId ||
      !platform.agent ||
      cancelingAgent
    )
      return
    setCancelingAgent(true)
    try {
      await platform.agent.sessions.abort(sessionId)
      const coordinator = agentStreamCoordinators.current.get(sessionId)
      if (!coordinator) throw new Error("Agent stream is not available")
      await settleQuickChatAgentStream(
        sessionId,
        coordinator.terminate(stoppedAgentEvent)
      )
      toast.success("Agent stopped.", {
        position: "bottom-right",
      })
    } catch (error) {
      showQuickChatError("Unable to cancel agent", errorMessage(error))
    } finally {
      setCancelingAgent(false)
    }
  }

  async function activeOrCreatedConversation(message: string) {
    if (activeConversation) {
      return currentChat(await detailedConversation(activeConversation))
    }
    const chat = await quickChats.create({
      title: titleFromMessage(message, project?.name),
      workspace: project?.path ?? null,
    })
    replaceChatRef(chat)
    void generateQuickChatTitle(chat, message)
    return chat
  }

  async function generateQuickChatTitle(chat: QuickChat, message: string) {
    const generateTitle = platform.agent?.promptOptimizer.generateTitle
    const model = selection.currentModel
    if (
      !generateTitle ||
      !model ||
      !project?.path ||
      auth.status !== "authenticated"
    )
      return
    try {
      const title = await generateAgentTitle(generateTitle, {
        apiConnection: auth.apiConnection,
        context: "quick-chat",
        providerId: model.provider.id,
        modelId: model.id,
        credentialLabel: model.credentialLabel,
        reasoningEffort: selection.currentVariant,
        prompt: message,
        workspace: project.path,
      })
      const updatedChat = await quickChats.update(currentChat(chat), { title })
      replaceChatRef(updatedChat)
    } catch {
      return
    }
  }

  async function detailedConversation(conversation: QuickChat) {
    if (quickChats.chatDetailsLoaded(conversation)) {
      return currentChat(conversation)
    }
    const chat = await quickChats.loadDetail(conversation)
    replaceChatRef(chat)
    return chat
  }

  async function runAgentForMessage(
    chat: QuickChat,
    message: QuickChatMessage,
    codeAttachments: PendingCodeSelectionAttachment[],
    fileAttachments: UserStoryFileAttachment[]
  ) {
    const executionId = crypto.randomUUID()
    const run = await quickChats.createAgentRun(chat, {
      checkpointRunCount: nextCheckpointRunCount(chat.agentRuns ?? []),
      executionId,
      kind: chat.clineSessionId ? "change-request" : "resume",
      messageId: message.id,
    })
    try {
      await startAgentSession(
        chat,
        run,
        message,
        codeAttachments,
        fileAttachments,
        executionId
      )
    } catch (error) {
      await markAgentRunFailed(chat, run, error)
      throw error
    }
  }

  async function startAgentSession(
    chat: QuickChat,
    run: QuickChatAgentRun,
    message: QuickChatMessage,
    codeAttachments: PendingCodeSelectionAttachment[],
    fileAttachments: UserStoryFileAttachment[],
    executionId: string
  ) {
    const workspace = project!.path
    const resumeSessionId = chat.clineSessionId
    const title = quickChatTitle(chat, message.body, project?.name)
    const summary = quickChatDevelopmentSummary(chat, message.body)
    const session = await startQuickChatDevelopmentSession({
      codeAttachments,
      executionId,
      fileAttachments,
      resumeSessionId,
      summary,
      title,
      workspace,
    })
    const reusedSession = Boolean(
      resumeSessionId && session.sessionId === resumeSessionId
    )
    const activeRun = await quickChats.updateAgentRun(chat, run, {
      clineSessionId: session.sessionId,
    })
    const updatedChat = await quickChats.update(currentChat(chat), {
      agentActivities: [],
      agentFinalResponse: null,
      agentLastError: null,
      agentLastEvent: `Cline debug log: ${quickChatClineLogPath(
        workspace,
        session.sessionId
      )}`,
      agentModelId: selection.currentModel!.id,
      agentProviderId: selection.currentModel!.provider.id,
      agentStatus: "Running",
      agentUsage: null,
      clineSessionId: session.sessionId,
      title,
      workspace,
    })
    replaceChatRef(updatedChat)
    subscribeQuickChatAgentEvents(updatedChat, activeRun, session.sessionId)
    await sendQuickChatPrompt({
      codeAttachments,
      executionId,
      fileAttachments,
      message,
      reusedSession,
      run: activeRun,
      sessionId: session.sessionId,
      summary,
      title,
      chat: updatedChat,
    })
  }

  async function startQuickChatDevelopmentSession(
    input: QuickChatDevelopmentSessionInput
  ) {
    return platform.agent!.sessions.startDevelopment({
      apiConnection: auth.apiConnection,
      providerId: selection.currentModel!.provider.id,
      modelId: selection.currentModel!.id,
      credentialLabel: selection.currentModel!.credentialLabel,
      reasoningEffort: selection.currentVariant,
      autoSendPrompt: false,
      title: input.title,
      summary: input.summary,
      codeSelectionAttachments: input.codeAttachments,
      fileAttachments: input.fileAttachments,
      cwd: input.workspace,
      resumeSessionId: input.resumeSessionId,
      workspaceRoot: input.workspace,
      previewDevtoolsScope: projectRunConfigurationPreviewKey(
        previewConfiguration,
        input.workspace
      ),
      codePractices: await projectCodePractices(auth, projects),
      executionId: input.executionId,
      projectId: project!.id,
    })
  }

  function subscribeQuickChatAgentEvents(
    chat: QuickChat,
    run: QuickChatAgentRun,
    sessionId: string
  ) {
    let authenticationFailed = false
    unsubscribeQuickChatAgentEvents(sessionId)
    const coordinator = new AgentStreamCoordinator({
      executionId: run.executionId ?? run.id,
      initialState: {
        agentActivities: run.activities ?? chat.agentActivities,
        agentFinalResponse: run.finalResponse ?? chat.agentFinalResponse,
        agentSessionSummary: run.sessionSummary ?? chat.agentSessionSummary,
        agentUsage: run.usage ?? chat.agentUsage,
      },
      lastSequenceNumber: run.lastSequenceNumber,
      onError: reportAgentPersistenceError,
      persist: (snapshot) =>
        persistAgentEvent(chat, run, snapshot.event, snapshot),
      runId: run.id,
      recoveredSnapshots: pendingAgentRunSnapshots(
        window.localStorage,
        chat.projectId,
        "quick-chat",
        run.id
      ),
      sessionId,
    })
    agentStreamCoordinators.current.set(sessionId, coordinator)
    const unsubscribe = subscribeAgentEvents(
      platform,
      sessionId,
      (event) => {
        if (authenticationFailed) return
        const text = agentEventText(event)
        authenticationFailed = quickChatExpiredAuthenticationToken(text)
        if (authenticationFailed) showExpiredAuthenticationToast(text)
        const persisted = terminalAgentRunEvent(event)
          ? coordinator.terminate(event)
          : coordinator.push(event)
        if (authenticationFailed || immediateQuickChatAgentEvent(event)) {
          void settleQuickChatAgentStream(
            sessionId,
            persisted,
            unsubscribe
          ).catch(reportAgentPersistenceError)
        }
      },
      run.executionId ?? undefined,
      run.lastSequenceNumber ?? 0
    )
    agentEventUnsubscribers.current.set(sessionId, unsubscribe)
    return unsubscribe
  }

  function unsubscribeQuickChatAgentEvents(
    sessionId: string,
    expected?: () => void
  ) {
    const unsubscribe = agentEventUnsubscribers.current.get(sessionId)
    if (!unsubscribe || (expected && unsubscribe !== expected)) return
    agentEventUnsubscribers.current.delete(sessionId)
    const coordinator = agentStreamCoordinators.current.get(sessionId)
    agentStreamCoordinators.current.delete(sessionId)
    unsubscribe()
    void coordinator?.disconnect().catch(reportAgentPersistenceError)
  }

  function settleQuickChatAgentStream(
    sessionId: string,
    persisted: Promise<unknown>,
    expected?: () => void
  ) {
    return persisted.then(
      (result) => {
        unsubscribeQuickChatAgentEvents(sessionId, expected)
        return result
      },
      (error) => {
        unsubscribeQuickChatAgentEvents(sessionId, expected)
        throw error
      }
    )
  }

  function clearQuickChatAgentStream(chat: QuickChat, run: QuickChatAgentRun) {
    const sessionId = run.clineSessionId ?? chat.clineSessionId
    if (sessionId) agentStreamStore.clear({ runId: run.id, sessionId })
  }

  async function sendQuickChatPrompt(input: QuickChatPromptInput) {
    try {
      await platform.agent!.sessions.sendDevelopment(quickChatSendInput(input))
    } catch (error) {
      const message = errorMessage(error)
      const coordinator = agentStreamCoordinators.current.get(input.sessionId)
      if (!coordinator) throw error
      await settleQuickChatAgentStream(
        input.sessionId,
        coordinator.terminate({
          payload: { message },
          sessionId: input.sessionId,
          type: "error",
        })
      )
    }
  }

  async function markAgentRunFailed(
    chat: QuickChat,
    run: QuickChatAgentRun,
    error: unknown
  ) {
    const message = errorMessage(error)
    const completedAt = new Date().toISOString()
    const chatInput = {
      agentLastError: message,
      agentLastEvent: message,
      agentStatus: null,
    }
    const runInput = {
      completedAt,
      finalResponse: message,
      status: "failed" as const,
    }
    updateChatLocal(chat, chatInput)
    quickChats.updateAgentRunLocal(chat, run, runInput)
    await Promise.all([
      quickChats.update(chat, chatInput).catch(() => undefined),
      quickChats.updateAgentRun(chat, run, runInput).catch(() => undefined),
    ])
  }

  const emptyConversation =
    activeConversationLoaded && !activeConversation?.agentRuns?.length

  return (
    <>
      <div className="flex h-svh min-h-0 min-w-0 flex-col overflow-hidden md:h-[calc(100svh_-_1rem)]">
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2">
          <main className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
            <MessageScrollerProvider key={activeConversation?.id ?? "new-chat"}>
              <MessageScroller>
                <MessageScrollerViewport>
                  <MessageScrollerContent
                    aria-busy={agentRunning}
                    className="mx-auto w-full max-w-4xl gap-10 px-4 pt-[calc(var(--header-height)+1rem)] pb-48 md:px-8"
                  >
                    <QuickChatStatus
                      error={quickChats.error}
                      loading={quickChats.loading || !activeConversationLoaded}
                      projectPath={project?.path}
                    />
                    {activeConversationLoaded &&
                    activeConversation?.agentRuns?.length ? (
                      <AgentConversationTimeline
                        comments={activeConversation.messages ?? []}
                        loadChangedFileDiffs={loadChangedFileDiffs}
                        loadChangedFiles={loadChangedFiles}
                        onChangedFileClick={(path) =>
                          openProjectPath(
                            project?.path,
                            path,
                            platform.openPath
                          )
                        }
                        onFileLinkClick={(path) =>
                          openProjectPath(
                            project?.path,
                            path,
                            platform.openPath
                          )
                        }
                        onLoadActivityDetail={(run, activity) =>
                          quickChats.agentRunActivityDetail(
                            activeConversation,
                            run,
                            activity
                          )
                        }
                        onUserMessageUndo={undoQuickChatMessage}
                        responseHeader={responseHeader}
                        runs={activeConversation.agentRuns}
                      />
                    ) : null}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton className="bottom-40 md:bottom-44" />
              </MessageScroller>
            </MessageScrollerProvider>
            <div
              className={
                emptyConversation
                  ? "absolute inset-0 z-20 flex flex-col justify-center overflow-y-auto px-3 pt-[calc(var(--header-height)+1rem)] pb-5 md:px-5"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-10 md:pt-12"
              }
            >
              <div
                className={
                  emptyConversation
                    ? "hidden"
                    : "absolute inset-0 bg-background/40 backdrop-blur-xl"
                }
                style={bottomBlurMask}
              />
              <div className="pointer-events-auto relative px-3 pb-3 md:px-5 md:pb-5">
                <div className="mx-auto w-full max-w-4xl">
                  {emptyConversation ? (
                    <QuickChatEmptyState
                      onSuggestion={project ? applySuggestion : undefined}
                    />
                  ) : null}
                  <AgentConversationComposer
                    speechSessionKey={draftStorageKey}
                    minHeight={emptyConversation ? "min-h-44" : "min-h-24"}
                    agentRunning={agentRunning}
                    cancelingAgent={cancelingAgent}
                    codeSelectionAttachments={draftCodeAttachments}
                    disabled={sending || agentRunning || !project}
                    editorKey={draftEditorKey}
                    editorRef={draftRef}
                    fileAttachments={pendingFileAttachments(
                      draftFileAttachments
                    )}
                    mentionDirectory={mentionDirectory}
                    message={draft}
                    onCodeSelectionAttachmentRemove={(id) =>
                      setDraftCodeAttachments((current) =>
                        current.filter((attachment) => attachment.id !== id)
                      )
                    }
                    onFileAttachmentRemove={(id) =>
                      setDraftFileAttachments((current) =>
                        current.filter((attachment) => attachment.id !== id)
                      )
                    }
                    onFileAttachmentsAdd={(attachments) =>
                      setDraftFileAttachments((current) => [
                        ...current,
                        ...attachments,
                      ])
                    }
                    onFileLinkClick={(path) =>
                      openProjectPath(project?.path, path, platform.openPath)
                    }
                    onMessageChange={setDraft}
                    onMessageSubmit={submitDraft}
                    onAgentCancel={cancelAgent}
                    placeholder={
                      agentRunning
                        ? "Agent is working in the current branch."
                        : "Ask for a focused code change"
                    }
                    submitLabel={agentRunning ? "Running" : "Send"}
                    toolbarEnd={
                      <div className="w-[28rem] max-w-full min-w-0">
                        <ModelSelector role="agent" />
                      </div>
                    }
                    turnMetrics={turnMetrics}
                  />
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
      <ProjectRunConfigurationPreviewWarmup
        configuration={previewConfiguration}
        devtoolsTarget
        scope={project?.path}
      />
    </>
  )
}
