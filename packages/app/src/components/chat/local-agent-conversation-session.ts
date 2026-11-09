import type {
  AgentConversationPurpose,
  AgentEvent,
  AgentPersonalization,
  ApiConnection,
} from "@blame/agent-runtime"
import { toast } from "sonner"

import {
  agentFlowUpdate,
  terminalAgentRunEvent,
} from "@/components/backlog/data/agent-flow"
import { subscribeAgentEvents } from "@/components/backlog/data/agent-event-stream"
import { AgentStreamCoordinator } from "@/components/backlog/data/agent-stream-coordinator"
import type {
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import type { AgentConversationRun } from "@/components/chat/agent-conversation"
import { quickChatClineLogRelativePath } from "@/components/chat/data/quick-chat-agent-flow"
import { agentTurnRecovery } from "@/components/chat/data/quick-chat-run-recovery"
import type { useModelSelection } from "@/components/model/model-selection"
import type { Platform } from "@/context/platform"
import { uploadFileAttachments } from "@/lib/file-attachment-api"

import {
  appendTurn,
  applyStreamSnapshot,
  emptyLocalConversation,
  endRun,
  loadLocalConversation,
  resumableRuns,
  saveLocalConversation,
  setCommentFileAttachments,
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

export type LocalAgentTurnOptions = {
  apiConnection: ApiConnection
  cwd?: string
  model: ReturnType<typeof useModelSelection>["currentModel"]
  // What the person chose for the agent, read when the turn starts.
  personalization?: AgentPersonalization
  platform: Platform
  projectId?: string
  purpose: AgentConversationPurpose
  reasoningEffort: ReturnType<typeof useModelSelection>["currentVariant"]
  title: string
  unavailableReason?: string
}

type Stream = { close(): void; runId: string; sessionId?: string }

const interruptedMessage = "The agent was interrupted."

// A conversation the app keeps itself (plan mode, the new-project
// assistant): its turns, its stream and what the stream saves. A kept
// conversation is shared by key and outlives the view that shows it, so a
// turn goes on when the dialog closes or another project opens, and is
// followed again (or closed from its log) after the app restarts.
export class LocalAgentConversationSession {
  private conversation: LocalAgentConversation
  private stream?: Stream
  private platform?: Platform
  private resuming = false
  private readonly listeners = new Set<() => void>()
  private readonly storageKey?: string

  constructor(storageKey?: string) {
    this.storageKey = storageKey
    this.conversation = loadLocalConversation(storageKey)
  }

  snapshot = () => this.conversation

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get running() {
    return this.conversation.runs.some((run) => run.status === "running")
  }

  stop() {
    const stream = this.closeStream()
    const run = this.conversation.runs.findLast(
      (item) => item.status === "running"
    )
    const runId = stream?.runId ?? run?.id
    if (!runId) return
    this.set((current) =>
      endRun(current, runId, "cancelled", "You stopped the agent.")
    )
    const sessionId = stream?.sessionId ?? run?.clineSessionId
    if (sessionId)
      void this.platform?.agent?.sessions.abort(sessionId).catch(() => {})
  }

  reset() {
    this.stop()
    this.set(() => emptyLocalConversation())
  }

  send(message: LocalAgentMessage, options: LocalAgentTurnOptions) {
    const text = message.text.trim()
    if (!text || this.stream || this.running || options.unavailableReason)
      return false
    this.platform = options.platform
    const now = new Date().toISOString()
    const commentId = crypto.randomUUID()
    const run: AgentConversationRun = {
      activities: [],
      createdAt: now,
      executionId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      kind: "change-request",
      messageId: commentId,
      modelId: options.model?.id,
      providerId: options.model?.provider.id,
      reasoningEffort: options.reasoningEffort,
      status: "running",
    }
    this.stream = { close: () => undefined, runId: run.id }
    this.set((current) =>
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
    void this.keepFiles(
      commentId,
      message.fileAttachments,
      options.apiConnection
    )
    void this.runTurn(run, { ...message, text }, options)
    return true
  }

  // The saved thread keeps no file content: uploading the files is what lets
  // it show and hand them over again after a reload. The agent reads the
  // originals meanwhile, so a failed upload never holds the turn back.
  private async keepFiles(
    commentId: string,
    files: UserStoryFileAttachment[] | undefined,
    apiConnection: ApiConnection
  ) {
    if (!this.storageKey || !files?.length) return
    try {
      const uploaded = await uploadFileAttachments(apiConnection, files)
      if (uploaded)
        this.set((current) =>
          setCommentFileAttachments(current, commentId, uploaded)
        )
    } catch (error) {
      toast.error("Unable to save your attachments", {
        description: `${errorMessage(error)} They will not be available after a reload.`,
      })
    }
  }

  // Turns left running by an earlier app session: follow the ones the
  // desktop still runs, close the others from their log, or as interrupted.
  async resume(platform: Platform, cwd: string | undefined) {
    if (this.resuming || this.stream) return
    this.resuming = true
    this.platform = platform
    try {
      for (const run of resumableRuns(this.conversation)) {
        if (this.stream) return
        await this.resumeRun(run, platform, cwd)
      }
    } finally {
      this.resuming = false
    }
  }

  private async resumeRun(
    run: AgentConversationRun,
    platform: Platform,
    cwd: string | undefined
  ) {
    const sessionId = run.clineSessionId
    const workspace = platform.workspace
    if (!sessionId || !run.executionId || !platform.agent || !workspace || !cwd)
      return this.interrupt(run.id)
    const recovery = await agentTurnRecovery(
      { agentRuns: this.conversation.runs },
      run,
      sessionId,
      {
        live: platform.agent.sessions.live,
        log: (id) =>
          workspace.readFile({
            root: cwd,
            path: quickChatClineLogRelativePath(id),
          }),
        messages: (id) => platform.agent!.sessions.messages(id),
      }
    )
    const current = this.conversation.runs.find((item) => item.id === run.id)
    if (current?.status !== "running") return
    if (!recovery) {
      // Older desktops cannot say whether the session runs: a stream
      // with no terminal event would hang, so only follow a live one.
      if (!platform.agent.sessions.live) return this.interrupt(run.id)
      this.stream = { close: () => undefined, runId: run.id, sessionId }
      this.follow(run, sessionId, run.executionId, platform)
      return
    }
    if (recovery.kind === "interrupted") return this.interrupt(run.id)
    this.applyTerminal(run, recovery.event)
  }

  private interrupt(runId: string) {
    this.set((current) =>
      endRun(current, runId, "cancelled", interruptedMessage)
    )
  }

  private applyTerminal(run: AgentConversationRun, event: AgentEvent) {
    const update = agentFlowUpdate(
      {
        agentActivities: run.activities ?? [],
        agentFinalResponse: run.finalResponse,
        agentUsage: run.usage,
      },
      event
    )
    this.set((current) => applyStreamSnapshot(current, run.id, update, event))
  }

  private set(
    update: (current: LocalAgentConversation) => LocalAgentConversation
  ) {
    this.conversation = update(this.conversation)
    saveLocalConversation(this.storageKey, this.conversation)
    for (const listener of this.listeners) listener()
  }

  private closeStream(runId?: string) {
    const stream = this.stream
    if (!stream || (runId && stream.runId !== runId)) return undefined
    this.stream = undefined
    stream.close()
    return stream
  }

  private follow(
    run: AgentConversationRun,
    sessionId: string,
    executionId: string,
    platform: Platform
  ) {
    const coordinator = new AgentStreamCoordinator({
      executionId,
      initialState: {
        agentActivities: run.activities ?? [],
        agentFinalResponse: run.finalResponse,
        agentUsage: run.usage,
      },
      lastSequenceNumber: run.lastSequenceNumber,
      persist: ({ event, persistenceEvent, update }) => {
        this.set((current) =>
          applyStreamSnapshot(current, run.id, update, event, {
            lastSequenceNumber: persistenceEvent.sequenceNumber,
          })
        )
        if (terminalAgentRunEvent(event))
          queueMicrotask(() => this.closeStream(run.id))
      },
      runId: run.id,
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
      executionId,
      run.lastSequenceNumber ?? 0
    )
    const close = () => {
      unsubscribe()
      void coordinator.disconnect().catch(() => undefined)
    }
    const stream = this.stream
    if (stream?.runId === run.id) Object.assign(stream, { close, sessionId })
    else close()
    return (event: AgentEvent) => coordinator.terminate(event)
  }

  private async runTurn(
    run: AgentConversationRun,
    message: LocalAgentMessage,
    options: LocalAgentTurnOptions
  ) {
    const agent = options.platform.agent
    const model = options.model
    const cwd = options.cwd?.trim()
    const executionId = run.executionId!
    const current = () => this.stream?.runId === run.id
    try {
      if (!agent || !model || !cwd) throw new Error("The agent is unavailable.")
      const session = await agent.sessions.startDevelopment({
        apiConnection: options.apiConnection,
        autoSendPrompt: false,
        checkpointEnabled: false,
        credentialLabel: model.credentialLabel,
        cwd,
        executionId,
        modelId: model.id,
        personalization: options.personalization,
        projectId: options.projectId,
        providerId: model.provider.id,
        purpose: options.purpose,
        reasoningEffort: options.reasoningEffort,
        resumeSessionId: this.conversation.sessionId ?? null,
        summary: message.text,
        title: options.title,
        workspaceRoot: cwd,
      })
      if (!current()) return
      this.set((value) => ({
        ...updateRun(value, run.id, { clineSessionId: session.sessionId }),
        sessionId: session.sessionId,
      }))
      const fail = this.follow(
        { ...run, clineSessionId: session.sessionId },
        session.sessionId,
        executionId,
        options.platform
      )
      await agent.sessions
        .sendDevelopment({
          executionId,
          feedback: [message.text, message.context]
            .filter(Boolean)
            .join("\n\n"),
          feedbackCodeSelectionAttachments: message.codeSelectionAttachments,
          feedbackFileAttachments: message.fileAttachments,
          feedbackOnly: true,
          personalization: options.personalization,
          sessionId: session.sessionId,
          summary: message.text,
          title: options.title,
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
      this.closeStream(run.id)
      this.set((value) => endRun(value, run.id, "failed", errorMessage(error)))
    }
  }
}

const sharedSessions = new Map<string, LocalAgentConversationSession>()

// One session per kept conversation for the whole app.
export function sharedLocalAgentConversation(storageKey: string) {
  const current = sharedSessions.get(storageKey)
  if (current) return current
  const session = new LocalAgentConversationSession(storageKey)
  sharedSessions.set(storageKey, session)
  return session
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
