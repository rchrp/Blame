import * as React from "react"
import type { EngineLocation } from "@blame/agent-runtime/engine-protocol"
import type { TurnOutcome } from "@blame/engine-client"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import type { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { usePlatform } from "@/context/platform"
import { useLatestCallback } from "@/lib/use-latest-callback"
import { storyLocation, storyOutcomeUpdate } from "./story-engine"

/**
 * Keeps each story's agent state in step with its engine session: Running
 * while a turn runs, then what the end of the turn means for the story. It
 * is the one writer of `agentStatus` once a story's agent has started.
 *
 * After Blame quits mid-turn (agents stop with the app), the stories it
 * left Running are settled from their records when the backlog loads.
 */
export function useStoryAgentOutcomes(
  backlog: ReturnType<typeof useBacklogStore>
) {
  const platform = usePlatform()
  const settled = React.useRef(new Set<string>())

  const apply = useLatestCallback(
    (session: string, running: boolean, outcome?: TurnOutcome) => {
      // The latest callback sees the stories as they are now.
      const story = backlog.stories.find(
        (item) => item.engineSessionId === session
      )
      if (!story) return
      if (running) {
        if (story.agentStatus !== "Running" && story.status === "in-progress")
          void backlog.update(story, { agentStatus: "Running" }).catch(report)
        return
      }
      void backlog
        .update(story, storyOutcomeUpdate(story, outcome))
        .catch(report)
    }
  )

  React.useEffect(
    () =>
      platform.engine?.onActivity((event) =>
        apply(event.session, event.running, event.outcome)
      ),
    [apply, platform.engine]
  )

  const recover = useLatestCallback(async (stories: UserStory[]) => {
    const engine = platform.engine
    if (!engine) return
    const left = stories.filter(
      (story) =>
        // In review, Running means Approve & Merge, not the agent.
        story.status === "in-progress" &&
        story.agentStatus === "Running" &&
        story.engineSessionId &&
        !settled.current.has(story.engineSessionId)
    )
    for (const story of left) settled.current.add(story.engineSessionId!)
    // Each engine answers for its own sessions (this computer's, the VM's).
    const byLocation = new Map<EngineLocation, UserStory[]>()
    for (const story of left) {
      const location = storyLocation(
        story.workspaceMode ?? "direct",
        platform.platform
      )
      byLocation.set(location, [...(byLocation.get(location) ?? []), story])
    }
    const statuses = (
      await Promise.all(
        [...byLocation].map(([location, stories]) =>
          engine
            .call("status", {
              sessions: stories.map((story) => story.engineSessionId!),
              location,
            })
            .catch(() => [])
        )
      )
    ).flat()
    for (const status of statuses) {
      if (status.running) continue
      const story = left.find((item) => item.engineSessionId === status.session)
      if (!story) continue
      void backlog
        .update(story, {
          ...storyOutcomeUpdate(story, status.lastOutcome),
          ...(status.exists
            ? {}
            : {
                agentStatus: "Paused" as const,
                agentLastError: "The agent's conversation could not be found.",
              }),
        })
        .catch(report)
    }
  })

  React.useEffect(() => {
    if (backlog.loading) return
    void recover(backlog.stories)
  }, [backlog.loading, backlog.stories, recover])
}

function report(error: unknown) {
  console.error("Could not record the story agent's state.", error)
}
