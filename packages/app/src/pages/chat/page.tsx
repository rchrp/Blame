import * as React from "react"
import { toast } from "sonner"

import { pendingFileAttachments } from "@/components/backlog/drawer/user-story-attachment-files"
import { projectPreviewConfiguration } from "@/components/backlog/board/project-run-configuration"
import type { AgentConversationUserMessageUndo } from "@/components/chat/agent-conversation"
import { useQuickChatStore } from "@/components/chat/data/quick-chat-store"
import { EngineApprovalProvider } from "@/components/chat/engine/engine-approvals"
import { QueuedMessages } from "@/components/chat/engine/queued-messages"
import { agentConversationResponseHeader } from "@/components/chat/agent-conversation-header"
import { composerDraftStorageKey } from "@/components/backlog/drawer/composer-draft-storage"
import { ExcerptTargetProvider } from "@/components/backlog/shared/selection-excerpt-actions"
import { useModelSelection } from "@/components/model/model-selection"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { useProjectInitialization } from "@/components/project-initialization/use-project-initialization"
import {
  errorMessage,
  openProjectPath,
  quickChatMessage,
  showQuickChatError,
} from "./quick-chat-helpers"
import { useComposerShortcuts } from "./use-composer-shortcuts"
import { useChatExcerpts } from "./use-chat-excerpts"
import { useQuickChatConversation } from "./use-quick-chat-conversation"
import { useQuickChatDraft } from "./use-quick-chat-draft"
import { PlanTab } from "@/components/chat/plan/plan-tab"
import { usePlanTabModel } from "@/components/chat/plan/use-plan-tab"
import { QuickChatView } from "./quick-chat-view"

export function ChatPage() {
  const projects = useProjects()
  const projectKey = projects.activeProject?.id ?? "project"

  return <QuickChatProjectPage key={projectKey} />
}

function QuickChatProjectPage() {
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
  const activeChat = quickChats.activeChat
  const chat = useQuickChatConversation(activeChat)
  const plan = usePlanTabModel(chat.transcript)
  const draftStorageKey = composerDraftStorageKey(
    project?.id ?? "project",
    "chat",
    activeChat?.id
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
    addDraftFileAttachments,
    removeDraftFileAttachment,
    replaceDraftFileAttachments,
  } = useQuickChatDraft(draftStorageKey)
  const attachExcerptAsContext = useChatExcerpts({
    addDraftCodeAttachments,
    hasActiveChat: Boolean(activeChat),
    projectId: project?.id,
    startNewChat: () => quickChats.setActiveId(undefined),
  })
  const applySuggestion = useComposerShortcuts({
    draftRef,
    setDraft,
    setDraftEditorKey,
  })
  const runs = chat.conversation?.runs ?? []
  const lastRun = runs.at(-1)
  const responseHeader = agentConversationResponseHeader({
    modelId: lastRun?.modelId ?? selection.currentModel?.id,
    providerId: lastRun?.providerId ?? selection.currentModel?.provider.id,
    providers: selection.allProviders,
  })
  const openPath = (path: string) =>
    openProjectPath(project?.path, path, platform.openPath)

  React.useEffect(() => {
    if (chat.error) showQuickChatError("Unable to load quick chat", chat.error)
  }, [chat.error])

  async function undoMessage(target: AgentConversationUserMessageUndo) {
    try {
      await chat.undo(target.comment.id)
    } catch (error) {
      showQuickChatError("Unable to undo the message", errorMessage(error))
      return
    }
    setDraft(target.comment.body)
    setDraftEditorKey((key) => key + 1)
    requestAnimationFrame(() => {
      draftRef.current
        ?.querySelector<HTMLElement>("[data-markdown-editor-input='true']")
        ?.focus()
    })
    toast.success("Message undone and restored to the editor.", {
      position: "bottom-right",
    })
  }

  // While the agent works, ↵ hands the message to the agent right away,
  // inside the turn it is running, and ⌘↵ queues it as the next turn.
  async function submitDraft(steer = false) {
    if (!draftHasContent() || (sending && !chat.running)) return
    const message = quickChatMessage(
      draft,
      draftCodeAttachments,
      draftFileAttachments
    )
    setSending(true)
    try {
      await chat.send(message, steer)
      clearDraft()
    } catch (error) {
      showQuickChatError("Quick chat failed", errorMessage(error))
    } finally {
      setSending(false)
    }
  }

  async function cancelAgent() {
    if (!chat.running || cancelingAgent) return
    setCancelingAgent(true)
    try {
      await chat.interrupt()
      toast.success("Agent stopped.", { position: "bottom-right" })
    } catch (error) {
      showQuickChatError("Unable to cancel agent", errorMessage(error))
    } finally {
      setCancelingAgent(false)
    }
  }

  const emptyConversation = chat.loaded && !runs.length

  return (
    <ExcerptTargetProvider attachAsContext={attachExcerptAsContext}>
      <EngineApprovalProvider session={activeChat?.engineSessionId}>
        <QuickChatView
          conversationId={activeChat?.id}
          emptyConversation={emptyConversation}
          status={{
            error: quickChats.error,
            loading: quickChats.loading || !chat.loaded,
            projectPath: project?.path,
          }}
          timeline={
            chat.loaded && chat.conversation && runs.length
              ? {
                  comments: chat.conversation.comments,
                  onChangedFileClick: openPath,
                  onFileLinkClick: openPath,
                  onUserMessageUndo: undoMessage,
                  queued: (
                    <QueuedMessages
                      controls={chat.queue}
                      onFileLinkClick={openPath}
                      queued={chat.conversation.queued}
                    />
                  ),
                  responseHeader,
                  runs,
                }
              : undefined
          }
          onSuggestion={project ? applySuggestion : undefined}
          composer={{
            planTab: <PlanTab model={plan} />,
            speechSessionKey: draftStorageKey,
            speechTarget: chatSpeechTarget(draftStorageKey),
            agentRunning: chat.running,
            cancelingAgent,
            codeSelectionAttachments: draftCodeAttachments,
            disabled: !project || !chat.loaded,
            submitting: sending && !chat.running,
            queueWhileRunning: true,
            editorKey: draftEditorKey,
            editorRef: draftRef,
            fileAttachments: pendingFileAttachments(draftFileAttachments),
            mentionDirectory: project?.path,
            message: draft,
            onCodeSelectionAttachmentRemove: (id) =>
              setDraftCodeAttachments((current) =>
                current.filter((attachment) => attachment.id !== id)
              ),
            onFileAttachmentRemove: removeDraftFileAttachment,
            onFileAttachmentsReplace: replaceDraftFileAttachments,
            onFileAttachmentsAdd: addDraftFileAttachments,
            onFileLinkClick: openPath,
            onMessageChange: setDraft,
            onMessageSubmit: () => void submitDraft(),
            onMessageSendNow: () => void submitDraft(true),
            onAgentCancel: cancelAgent,
            placeholder: chat.running
              ? "Message the agent: ↵ right now, ⌘↵ when it finishes"
              : "Ask for a focused code change",
            submitLabel: chat.running ? "Send to the agent now" : "Send",
          }}
          preview={{
            configuration: previewConfiguration,
            devtoolsTarget: true,
            scope: project?.path,
          }}
          stats={
            activeChat && chat.transcript && !emptyConversation
              ? {
                  chatId: activeChat.id,
                  compaction: chat.compaction,
                  running: chat.running,
                  runs,
                  transcript: chat.transcript,
                }
              : undefined
          }
        />
      </EngineApprovalProvider>
    </ExcerptTargetProvider>
  )
}

function chatSpeechTarget(draftKey: string) {
  return { draftKey, label: "your chat message" }
}
