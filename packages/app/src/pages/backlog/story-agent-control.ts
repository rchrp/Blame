import type { EnginePlatformClient } from "@blame/agent-runtime/engine-protocol"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import { storyLocation } from "./story-engine.ts"

/**
 * Stops the turn a pause interrupts. The engine ends it as interrupted and
 * the story is then paused where it was (useStoryAgentOutcomes). Returns
 * the engine's refusal, if any.
 */
export function pauseInterruptRefusal(
  story: Pick<UserStory, "agentStatus" | "engineSessionId" | "workspaceMode">,
  engine: Pick<EnginePlatformClient, "call"> | undefined,
  platformName: string | undefined
): Promise<{ error: unknown } | undefined> {
  if (!story.engineSessionId || story.agentStatus !== "Running")
    return Promise.resolve(undefined)
  return Promise.resolve(
    engine?.call("interrupt", {
      session: story.engineSessionId,
      location: storyLocation(story.workspaceMode ?? "direct", platformName),
    })
  ).then(
    () => undefined,
    (error: unknown) => ({ error })
  )
}
