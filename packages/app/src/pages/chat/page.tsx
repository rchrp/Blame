import * as React from "react"
import { toast } from "sonner"

import { pendingFileAttachments } from "@/components/backlog/drawer/user-story-attachment-files"
import { projectPreviewConfiguration } from "@/components/backlog/board/project-run-configuration"
import {
  screenshotOwnerFor,
  type AgentConversationUserMessageUndo,
} from "@/components/chat/agent-conversation"
import { loadAgentRunDiffs } from "@/components/chat/agent-run-diffs"
import {
  latestLinkedAgentTurn,
  useAgentTurnMetrics,
} from "@/components/chat/agent-turn-metrics"
import { quickChatAgentRunning } from "@/components/chat/data/quick-chat-agent-control"
import type { QuickChat } from "@/components/chat/data/quick-chat-data"
import { useQuickChatStore } from "@/components/chat/data/quick-chat-store"
import { agentConversationResponseHeader } from "@/components/chat/agent-conversation-header"
import { composerDraftStorageKey } from "@/components/backlog/drawer/composer-draft-storage"
import { ExcerptTargetProvider } from "@/components/backlog/shared/selection-excerpt-actions"
import { useModelSelection } from "@/components/model/model-selection"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { useProjectInitialization } from "@/components/project-initialization/use-project-initialization"
import { QueuedComments } from "@/components/backlog/drawer/queued-comments"
import {
  generatedQuickChatTitle,
  useQuickChatComposerQueue,
} from "@/pages/chat/use-quick-chat-queue"
import {
  errorMessage,
  openProjectPath,
  quickChatMessageBody,
  restoreQuickChatCheckpoint,
  showQuickChatError,
  titleFromMessage,
} from "./quick-chat-helpers"
import { useQuickChatAgentRunner } from "./quick-chat-agent-runner"
import { useComposerShortcuts } from "./use-composer-shortcuts"
import { useChatExcerpts } from "./use-chat-excerpts"
import { useQuickChatDraft } from "./use-quick-chat-draft"
import { QuickChatView } from "./quick-chat-view"

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
  const runner = useQuickChatAgentRunner()
  const selection = useModelSelection({ role: "agent" })
  const project = projects.activeProject
  const previewConfiguration = projectPreviewConfiguration(
    projectInitialization?.initialization?.runConfigurations ?? []
  )
  const [sending, setSending] = React.useState(false)
  const [cancelingAgent, setCancelingAgent] = React.useState(false)
  const activeConversation = quickChats.activeChat
  const draftStorageKey = composerDraftStorageKey(
    project?.id ?? "project",
    "chat",
    activeConversation?.id
  )
  const {
    addDraftCodeAttachments,
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
    addDraftFileAttachments,
    removeDraftFileAttachment,
    replaceDraftFileAttachments,
  } = useQuickChatDraft(draftStorageKey)
  const attachExcerptAsContext = useChatExcerpts({
    addDraftCodeAttachments,
    hasActiveChat: Boolean(quickChats.activeChat),
    projectId: project?.id,
    startNewChat: () => quickChats.setActiveId(undefined),
  })
  const applySuggestion = useComposerShortcuts({
    draftRef,
    setDraft,
    setDraftEditorKey,
  })
  const activeConversationLoaded =
    !activeConversation || quickChats.chatDetailsLoaded(activeConversation)
  const responseHeader = agentConversationResponseHeader({
    modelId: activeConversation?.agentModelId ?? selection.currentModel?.id,
    providerId:
      activeConversation?.agentProviderId ??
      selection.currentModel?.provider.id,
    providers: selection.allProviders,
  })
  const activeWorkspace = activeConversation?.workspace
  const loadChangedFileDiffs = React.useCallback(
    (sessionId: string, checkpointRunCount: number, diffEndRef: string) => {
      if (!activeWorkspace) return Promise.resolve([])
      return loadAgentRunDiffs({
        checkpointRunCount,
        diffEndRef,
        platform,
        root: activeWorkspace,
        sessionId,
      })
    },
    [activeWorkspace, platform]
  )
  const mentionDirectory = project?.path
  const agentRunning = quickChatAgentRunning(activeConversation)
  const messageQueue = useQuickChatComposerQueue(activeConversation?.id)
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
    if (!activeConversation || quickChats.chatDetailsLoaded(activeConversation))
      return
    void quickChats.loadDetail(activeConversation).catch((error) => {
      showQuickChatError("Unable to load quick chat", errorMessage(error))
    })
  }, [activeConversation, quickChats])

  async function undoQuickChatMessage(
    target: AgentConversationUserMessageUndo
  ) {
    if (!activeConversation) return
    const current = await runner.detailedChat(activeConversation)
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
    runner.rememberChat(nextConversation)
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

  async function submitDraft(sendNow = false) {
    if (!draftHasContent()) return
    // The agent is working: the message waits for it (or "Send now").
    if (agentRunning && messageQueue.key) {
      const body = quickChatMessageBody(
        draft,
        draftCodeAttachments,
        draftFileAttachments
      )
      messageQueue.queue(
        {
          body,
          codeSelectionAttachments: draftCodeAttachments,
          fileAttachments: draftFileAttachments,
        },
        sendNow
      )
      return clearDraft()
    }
    if (
      sending ||
      (activeConversation && quickChats.busyChatIds.has(activeConversation.id))
    )
      return
    const validationError = runner.sendValidationError()
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
      await runner.sendMessage(
        chat,
        {
          body: messageBody,
          codeSelectionAttachments: codeAttachments,
          fileAttachments,
        },
        clearDraft
      )
    } catch (error) {
      showQuickChatError("Quick chat failed", errorMessage(error))
    } finally {
      setSending(false)
    }
  }

  async function cancelAgent() {
    const conversation = activeConversation
      ? runner.currentChat(activeConversation)
      : undefined
    if (!conversation || !agentRunning || cancelingAgent) return
    setCancelingAgent(true)
    try {
      runner.rememberChat(await quickChats.stopAgent(conversation))
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
      return runner.currentChat(await runner.detailedChat(activeConversation))
    }
    const chat = await quickChats.create({
      title: titleFromMessage(message, project?.name),
      workspace: project?.path ?? null,
    })
    runner.rememberChat(chat)
    void generateQuickChatTitle(chat, message)
    return chat
  }

  async function generateQuickChatTitle(chat: QuickChat, message: string) {
    const title = await generatedQuickChatTitle(message, {
      auth,
      generateTitle: platform.agent?.promptOptimizer.generateTitle,
      projectPath: project?.path,
      selection,
    })
    if (title)
      runner.rememberChat(
        await quickChats.update(runner.currentChat(chat), { title })
      )
  }

  const emptyConversation =
    activeConversationLoaded && !activeConversation?.agentRuns?.length

  return (
    <ExcerptTargetProvider attachAsContext={attachExcerptAsContext}>
      <QuickChatView
        conversationId={activeConversation?.id}
        emptyConversation={emptyConversation}
        status={{
          error: quickChats.error,
          loading: quickChats.loading || !activeConversationLoaded,
          projectPath: project?.path,
        }}
        timeline={activeConversationLoaded && activeConversation?.agentRuns?.length ? {
          screenshotOwner: screenshotOwnerFor("quickChat", activeConversation.id),
          comments: activeConversation.messages ?? [],
          loadChangedFileDiffs,
          onChangedFileClick: (path) => openProjectPath(project?.path, path, platform.openPath),
          onFileLinkClick: (path) => openProjectPath(project?.path, path, platform.openPath),
          onLoadActivityDetail: (run, activity) =>
            quickChats.agentRunActivityDetail(activeConversation, run, activity),
          onUserMessageUndo: undoQuickChatMessage,
          responseHeader,
          queued: (
            <QueuedComments
              author={activeConversation.messages?.at(-1)?.author ?? "You"}
              storyId={messageQueue.key}
            />
          ),
          runs: activeConversation.agentRuns,
        } : undefined}
        onSuggestion={project ? applySuggestion : undefined}
        composer={{
          speechSessionKey: draftStorageKey,
          speechTarget: chatSpeechTarget(draftStorageKey),
          agentRunning,
          cancelingAgent,
          codeSelectionAttachments: draftCodeAttachments,
          disabled: !project || !activeConversationLoaded,
          submitting: sending && !agentRunning,
          queueWhileRunning: true,
          editorKey: draftEditorKey,
          editorRef: draftRef,
          fileAttachments: pendingFileAttachments(draftFileAttachments),
          mentionDirectory,
          message: draft,
          onCodeSelectionAttachmentRemove: (id) =>
            setDraftCodeAttachments((current) => current.filter((attachment) => attachment.id !== id)),
          onFileAttachmentRemove: removeDraftFileAttachment,
          onFileAttachmentsReplace: replaceDraftFileAttachments,
          onFileAttachmentsAdd: addDraftFileAttachments,
          onFileLinkClick: (path) => openProjectPath(project?.path, path, platform.openPath),
          onMessageChange: setDraft,
          onMessageSubmit: () => void submitDraft(),
          onMessageSendNow: () => void submitDraft(true),
          onAgentCancel: cancelAgent,
          placeholder: agentRunning
            ? "Message the agent: ↵ when it finishes, ⌘↵ right now"
            : "Ask for a focused code change",
          submitLabel: agentRunning ? "Queue message" : "Send",
          turnMetrics,
        }}
        preview={{ configuration: previewConfiguration, devtoolsTarget: true, scope: project?.path }}
        stats={emptyConversation ? undefined : activeConversation}
      />
    </ExcerptTargetProvider>
  )
}

function chatSpeechTarget(draftKey: string) {
  return { draftKey, label: "your chat message" }
}
