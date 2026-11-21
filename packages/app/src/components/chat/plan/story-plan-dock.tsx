import { useStoryConversation } from "@/components/backlog/drawer/story-conversation"
import type { UserStory } from "@/components/backlog/data/backlog-data"
import { planProgress } from "@blame/engine-client/transcript"

import { PlanDock } from "./plan-dock"
import { PlanProgressLine } from "./plan-progress-line"
import { usePlanDockModel } from "./use-plan-dock"

/** The open story's plan, pinned above its composer. */
export function StoryPlanDock() {
  const { transcript } = useStoryConversation()
  return <PlanDock model={usePlanDockModel(transcript)} />
}

/**
 * Where the plan stands, beside the story's status, on every tab of the
 * drawer, while the agent works.
 */
export function StoryPlanBadge({
  story,
}: {
  story: Pick<UserStory, "agentStatus"> | undefined
}) {
  const { transcript } = useStoryConversation()
  const progress = planProgress(transcript?.plan)
  const working =
    story?.agentStatus === "Running" || transcript?.runningTurn !== undefined
  if (!progress || !working) return null
  return <PlanProgressLine className="max-w-72" progress={progress} />
}
