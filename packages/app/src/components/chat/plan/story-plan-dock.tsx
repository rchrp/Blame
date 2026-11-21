import { useStoryConversation } from "@/components/backlog/drawer/story-conversation"

import { PlanDock } from "./plan-dock"
import { usePlanDockModel } from "./use-plan-dock"

/** The open story's plan, pinned above its composer. */
export function StoryPlanDock() {
  const { transcript } = useStoryConversation()
  return <PlanDock model={usePlanDockModel(transcript)} />
}
