import * as React from "react"

import type { AgentConversationRun } from "@/components/chat/agent-conversation"
import {
  fullToolDetail,
  proposalId,
  proposedStories,
  storyProposalToolName,
} from "@/components/chat/proposals/proposal-tools"
import {
  useLocalAgentConversation,
  type LocalAgentMessage,
} from "@/components/chat/use-local-agent-conversation"
import { useModelSelection } from "@/components/model/model-selection"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"

import { decidedStories, proposalDecisionsNote } from "./story-proposal-data"
import { proposalDecisions } from "./story-proposal-state"

// Each project's conversation belongs to the app: mounting this for another
// project shows that project's conversation, while a turn of the previous one
// goes on and keeps saving.
export function usePlanMode() {
  const platform = usePlatform()
  const auth = useCloudAuth()
  const project = useProjects().activeProject
  const selection = useModelSelection({ role: "agent" })
  const projectId = project?.id
  const unavailableReason = !platform.agent
    ? "Plan mode runs in the Blame desktop app."
    : !project?.path || !projectId
      ? "Open a project to plan with your agent."
      : auth.status !== "authenticated"
        ? "Sign in to plan with your agent."
        : !selection.currentModel
          ? "Choose an AI model below to start planning."
          : undefined
  const conversation = useLocalAgentConversation({
    cwd: project?.path,
    projectId,
    purpose: "plan",
    selection,
    storageKey: projectId ? `blame:plan-mode:v2:${projectId}` : undefined,
    title: "Plan Mode",
    unavailableReason,
  })

  // Plan mode conversations used to be kept in another format.
  React.useEffect(() => {
    if (!projectId) return
    try {
      localStorage.removeItem(`blame:plan-mode:v1:${projectId}`)
    } catch {
      // Nothing to clean up.
    }
  }, [projectId])

  function send(message: LocalAgentMessage) {
    // The agent only sees its own tool call: tell it what became of it.
    const note = latestProposalNote(conversation.conversation.runs, projectId)
    return conversation.send({
      ...message,
      context: [note, message.context].filter(Boolean).join("\n\n"),
    })
  }

  return {
    ...conversation,
    model: selection.currentModel,
    projectPath: project?.path,
    send,
    unavailableReason,
  }
}

export type PlanMode = ReturnType<typeof usePlanMode>

function latestProposalNote(
  runs: AgentConversationRun[],
  projectId: string | undefined
) {
  for (const run of [...runs].reverse()) {
    const activity = (run.activities ?? []).findLast(
      (item) =>
        item.toolName === storyProposalToolName && item.status === "completed"
    )
    const detail = activity ? fullToolDetail(activity.detail) : undefined
    if (!activity || !detail) continue
    const decisions = proposalDecisions(projectId)[proposalId(run, activity)]
    return proposalDecisionsNote(
      decidedStories(proposedStories(detail), decisions)
    )
  }
  return undefined
}
