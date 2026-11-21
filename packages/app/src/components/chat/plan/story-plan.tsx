import { useStoryConversation } from "@/components/backlog/drawer/story-conversation"
import type { UserStory } from "@/components/backlog/data/backlog-data"
import { planProgress } from "@blame/engine-client/transcript"

import { PlanTab } from "./plan-tab"
import { PlanProgressLine } from "./plan-progress-line"
import { usePlanDockModel } from "./use-plan-dock"

/** The open story's plan, as a tab on its composer. */
export function StoryPlanTab() {
  const { transcript } = useStoryConversation()
  return <PlanTab model={usePlanDockModel(transcript)} />
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
  return <PlanProgressLine
      className="max-w-64 rounded-full border border-foreground/15 px-2 py-0.5"
      progress={progress}
    />
}
