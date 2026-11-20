import * as React from "react"

import type { AgentConversationRun } from "@/components/chat/agent-conversation"
import {
  fullToolDetail,
  proposalId,
  proposedStories,
  storyProposalToolName,
} from "@/components/chat/proposals/proposal-tools"
import { engineModelChoice } from "@/components/chat/engine/engine-model"
import {
  useEngineConversation,
  type EngineConversationMessage,
} from "@/components/chat/engine/use-engine-conversation"
import { useModelSelection } from "@/components/model/model-selection"
import { storyMaxInputTokens } from "@/components/backlog/data/story-context-limit"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { conversationPersonalization } from "@/lib/agent-personalization"
import { planModeAmbitionKey } from "@/lib/conversation-ambition"

import { decidedStories, proposalDecisionsNote } from "./story-proposal-data"
import { proposalDecisions } from "./story-proposal-state"

// Each project's conversation is an engine session named in local storage:
// mounting this for another project shows that project's conversation, while
// a turn of the previous one goes on in the engine host.
export function usePlanMode() {
  const platform = usePlatform()
  const auth = useCloudAuth()
  const project = useProjects().activeProject
  const selection = useModelSelection({ role: "agent" })
  const projectId = project?.id
  const ambitionKey = planModeAmbitionKey(projectId)
  const unavailableReason = !platform.engine
    ? "Plan mode runs in the Blame desktop app."
    : !project?.path || !projectId
      ? "Open a project to plan with your agent."
      : auth.status !== "authenticated"
        ? "Sign in to plan with your agent."
        : !selection.currentModel
          ? "Choose an AI model below to start planning."
          : undefined
  const conversation = useEngineConversation({
    settings: () => ({
      purpose: "plan",
      settings: {
        workspace: { root: project!.path!, location: "host" },
        projectId: projectId!,
        model: engineModelChoice(selection),
        maxContextTokens: storyMaxInputTokens(
          ambitionKey,
          selection.currentModel!,
          selection.allProviders
        ),
        personalization: conversationPersonalization(ambitionKey),
      },
    }),
    storageKey: projectId ? `blame:plan-mode:v3:${projectId}` : undefined,
    unavailableReason,
  })

  // Plan mode conversations used to be kept by the app, in other formats.
  React.useEffect(() => {
    if (!projectId) return
    try {
      localStorage.removeItem(`blame:plan-mode:v1:${projectId}`)
      localStorage.removeItem(`blame:plan-mode:v2:${projectId}`)
    } catch {
      // Nothing to clean up.
    }
  }, [projectId])

  function send(message: EngineConversationMessage) {
    // The agent only sees its own tool call: tell it what became of it.
    const note = latestProposalNote(conversation.conversation.runs, projectId)
    return conversation.send({
      ...message,
      context: [note, message.context].filter(Boolean).join("\n\n"),
    })
  }

  return {
    ...conversation,
    ambitionKey,
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
