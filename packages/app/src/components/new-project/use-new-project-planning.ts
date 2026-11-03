import * as React from "react"

import type { AgentConversationRun } from "@/components/chat/agent-conversation"
import {
  fullToolDetail,
  projectStackProposalToolName,
  proposedConfiguration,
} from "@/components/chat/proposals/proposal-tools"
import {
  useLocalAgentConversation,
  type LocalAgentMessage,
} from "@/components/chat/use-local-agent-conversation"
import type { useModelSelection } from "@/components/model/model-selection"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"

import {
  parseNewProjectConfiguration,
  type NewProjectConfiguration,
} from "./new-project-options"

/** The stack conversation of the new-project wizard, on the agent model. */
export function useNewProjectPlanning(input: {
  open: boolean
  projectName: string
  parentPath: string
  selection: ReturnType<typeof useModelSelection>
}) {
  const platform = usePlatform()
  const auth = useCloudAuth()
  const unavailableReason = !platform.agent
    ? "Project guidance runs in the Blame desktop app."
    : auth.status !== "authenticated"
      ? "Sign in to describe your project to the agent."
      : !input.selection.currentModel
        ? "Choose an AI model below to get started."
        : undefined
  const chat = useLocalAgentConversation({
    cwd: input.parentPath,
    purpose: "new-project",
    selection: input.selection,
    title: input.projectName.trim(),
    unavailableReason,
  })

  // A changed destination or a closed wizard starts a fresh conversation.
  const reset = chat.reset
  React.useEffect(() => {
    reset()
  }, [input.open, input.parentPath, input.projectName, reset])

  const runs = chat.conversation.runs
  return {
    conversation: chat.conversation,
    proposal: chat.running ? undefined : latestStack(runs),
    pending: chat.running,
    unavailableReason,
    send: (message: LocalAgentMessage) => chat.send(message),
    stop: chat.stop,
    reset,
  }
}

/** The stack of one propose_project_stack call, once it succeeded. */
export function stackProposal(detail: string) {
  const parsed = fullToolDetail(detail)
  if (!parsed) return undefined
  try {
    return parseNewProjectConfiguration(proposedConfiguration(parsed))
  } catch {
    return undefined
  }
}

/** The most recent stack the agent proposed in a finished turn. */
function latestStack(
  runs: AgentConversationRun[]
): NewProjectConfiguration | undefined {
  for (const run of [...runs].reverse()) {
    if (run.status !== "completed") continue
    const call = (run.activities ?? []).findLast(
      (item) =>
        item.toolName === projectStackProposalToolName &&
        item.status === "completed"
    )
    const stack = call ? stackProposal(call.detail) : undefined
    if (stack) return stack
  }
  return undefined
}
