import * as React from "react"
import { toast } from "sonner"

import { agentFlowUpdate } from "@/components/backlog/data/agent-flow"
import {
  userStoryDisplayId,
  type UserStoryAgentActivity,
} from "@/components/backlog/data/backlog-data"
import { useBacklogStore } from "@/components/backlog/data/backlog-store"
import {
  describeToolCall,
  toolCallSource,
} from "@/components/chat/tool-calls/describe-tool-call"
import { useModelSelection } from "@/components/model/model-selection"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { readStoryRunMode } from "@/lib/runtime-preference"

import {
  addedStoryRefs,
  emptyPlanThread,
  loadPlanThread,
  planTurnMessages,
  plannedStoryMarkdown,
  savePlanThread,
  storiesToAdd,
  updatePlanStory,
  type PlanMessage,
  type PlanStory,
  type PlanThread,
} from "./plan-mode-data"

export type PlanStep = { id: string; label: string; running: boolean }
export type PlanPending = {
  messageId: string
  sessionId: string
  startedAt: number
  steps: PlanStep[]
}
export type PlanStoryEdit = Partial<
  Pick<PlanStory, "priority" | "summary" | "title">
>

const maxVisibleSteps = 4

// Mount it once per project (keyed by project id): the conversation of
// each project is loaded on mount and saved on every change.
export function usePlanMode() {
  const platform = usePlatform()
  const auth = useCloudAuth()
  const projects = useProjects()
  const backlog = useBacklogStore()
  const selection = useModelSelection({ role: "agent" })
  const project = projects.activeProject
  const projectId = project?.id
  const [thread, setThreadState] = React.useState<PlanThread>(() =>
    loadPlanThread(projectId)
  )
  const threadRef = React.useRef(thread)
  const [pending, setPending] = React.useState<PlanPending>()
  const pendingRef = React.useRef<PlanPending | undefined>(undefined)
  const [adding, setAdding] = React.useState<ReadonlySet<string>>(new Set())

  const setThread = React.useCallback(
    (update: (current: PlanThread) => PlanThread) => {
      const next = update(threadRef.current)
      threadRef.current = next
      setThreadState(next)
      savePlanThread(projectId, next)
    },
    [projectId]
  )

  const unavailableReason = !platform.agent?.planning
    ? "Plan mode runs in the Blame desktop app."
    : !project?.path || !projectId
      ? "Open a project to plan with your agent."
      : auth.status !== "authenticated"
        ? "Sign in to plan with your agent."
        : !selection.currentModel
          ? "Choose an AI model below to start planning."
          : undefined

  async function runTurn(messages: PlanMessage[], messageId: string) {
    const agent = platform.agent
    const model = selection.currentModel
    if (!agent?.planning || !model || !project?.path || !projectId) return
    const sessionId = `plan_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`
    const state: PlanPending = {
      messageId,
      sessionId,
      startedAt: Date.now(),
      steps: [],
    }
    pendingRef.current = state
    setPending(state)
    let activities: UserStoryAgentActivity[] = []
    const unsubscribe = agent.sessions.onEvent(sessionId, (event) => {
      if (pendingRef.current?.sessionId !== sessionId) return
      const update = agentFlowUpdate({ agentActivities: activities }, event)
      if (!update.agentActivities) return
      activities = update.agentActivities
      const steps = planSteps(activities)
      setPending((current) =>
        current?.sessionId === sessionId ? { ...current, steps } : current
      )
    })
    const current = () => pendingRef.current?.sessionId === sessionId
    try {
      const result = await agent.planning.reply({
        apiConnection: auth.apiConnection,
        providerId: model.provider.id,
        modelId: model.id,
        credentialLabel: model.credentialLabel,
        reasoningEffort: selection.currentVariant,
        cwd: project.path,
        workspaceRoot: project.path,
        projectId,
        sessionId,
        messages: planTurnMessages(messages),
        notes: threadRef.current.notes,
      })
      if (!current()) return
      setThread((thread) => ({
        messages: [
          ...thread.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: result.message,
            createdAt: new Date().toISOString(),
            ...(result.stories.length ? { stories: result.stories } : {}),
          },
        ],
        notes: result.notes ?? thread.notes,
        updatedAt: new Date().toISOString(),
      }))
    } catch (error) {
      if (!current()) return
      markFailed(messageId, errorMessage(error))
    } finally {
      unsubscribe?.()
      if (current()) {
        pendingRef.current = undefined
        setPending(undefined)
      }
    }
  }

  function markFailed(messageId: string, error: string) {
    setThread((thread) => ({
      ...thread,
      messages: thread.messages.map((message) =>
        message.id === messageId ? { ...message, error, failed: true } : message
      ),
      updatedAt: new Date().toISOString(),
    }))
  }

  function send(
    text: string,
    extra: Pick<PlanMessage, "attachments" | "context"> = {}
  ) {
    if (pendingRef.current || unavailableReason) return false
    const message: PlanMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: text.trim(),
      createdAt: new Date().toISOString(),
      ...(extra.context ? { context: extra.context } : {}),
      ...(extra.attachments?.length ? { attachments: extra.attachments } : {}),
    }
    const messages = [...threadRef.current.messages, message]
    setThread((thread) => ({
      ...thread,
      messages,
      updatedAt: new Date().toISOString(),
    }))
    void runTurn(messages, message.id)
    return true
  }

  function retry(messageId: string) {
    if (pendingRef.current || unavailableReason) return
    const index = threadRef.current.messages.findIndex(
      (message) => message.id === messageId
    )
    if (index < 0) return
    const messages = threadRef.current.messages
      .slice(0, index + 1)
      .map((message) =>
        message.id === messageId
          ? { ...message, error: undefined, failed: undefined }
          : message
      )
    setThread((thread) => ({
      ...thread,
      messages,
      updatedAt: new Date().toISOString(),
    }))
    void runTurn(messages, messageId)
  }

  function stop() {
    const state = pendingRef.current
    if (!state) return
    pendingRef.current = undefined
    setPending(undefined)
    markFailed(state.messageId, "You stopped the agent.")
    void platform.agent?.sessions.abort(state.sessionId).catch(() => undefined)
  }

  function reset() {
    stop()
    setThread(() => emptyPlanThread())
  }

  function edit(messageId: string, key: string, patch: PlanStoryEdit) {
    setThread((thread) => updatePlanStory(thread, messageId, key, patch))
  }

  function dismiss(messageId: string, key: string, dismissed: boolean) {
    setThread((thread) =>
      updatePlanStory(thread, messageId, key, { dismissed })
    )
  }

  async function addStories(messageId: string, keys: string[]) {
    const message = threadRef.current.messages.find(
      (item) => item.id === messageId
    )
    const stories = storiesToAdd(message?.stories ?? [], keys)
    if (!stories.length) return
    const refs = addedStoryRefs(threadRef.current.messages)
    const adds = stories.map((story) => `${messageId}:${story.key}`)
    setAdding((current) => new Set([...current, ...adds]))
    const created: string[] = []
    try {
      for (const story of stories) {
        const draft = {
          title: story.title,
          summary: plannedStoryMarkdown(story, (key) => refs.get(key)),
          priority: story.priority,
          status: "backlog" as const,
          runMode: readStoryRunMode(),
        }
        const userStory = await backlog.create(draft)
        const displayId = userStoryDisplayId(userStory)
        refs.set(story.key, { id: userStory.id, displayId, title: story.title })
        created.push(displayId)
        setThread((thread) =>
          updatePlanStory(thread, messageId, story.key, {
            addedAs: displayId,
            addedStoryId: userStory.id,
            dismissed: undefined,
          })
        )
      }
    } catch (error) {
      toast.error("Unable to add the story to the backlog", {
        description: errorMessage(error),
      })
    } finally {
      setAdding((current) => {
        const next = new Set(current)
        for (const id of adds) next.delete(id)
        return next
      })
    }
    if (created.length)
      toast.success(
        created.length === 1
          ? `${created[0]} added to the backlog`
          : `${created.length} stories added to the backlog`,
        { description: created.length > 1 ? created.join(", ") : undefined }
      )
  }

  return {
    adding,
    addStories,
    dismiss,
    edit,
    model: selection.currentModel,
    pending,
    projectPath: project?.path,
    reset,
    retry,
    send,
    stop,
    stories: backlog.stories,
    thread,
    unavailableReason,
  }
}

export type PlanMode = ReturnType<typeof usePlanMode>

function planSteps(activities: UserStoryAgentActivity[]): PlanStep[] {
  return activities
    .filter((activity) => activity.kind === "tool")
    .map((activity) => ({
      activity,
      source: toolCallSource(activity, activity.status === "running"),
    }))
    .filter(({ source }) => source.toolName !== "submit_plan_reply")
    .slice(-maxVisibleSteps)
    .map(({ activity, source }) => {
      const view = describeToolCall(source)
      return {
        id: activity.id,
        label: [view.verb, view.target?.text].filter(Boolean).join(" "),
        running: source.running,
      }
    })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
