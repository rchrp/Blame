import type {
  UserStory,
  UserStoryAgentRun,
  UserStoryAgentRunFinalization,
} from "@/components/backlog/data/backlog-data"
import { runningAgentRunsForStory } from "./agent-run-liveness"

type BacklogRuns = {
  finalizeAgentRun(
    story: UserStory,
    run: UserStoryAgentRun,
    input: UserStoryAgentRunFinalization
  ): Promise<UserStory>
  loadDetail(story: UserStory): Promise<UserStory>
}

// Closes the run that was executing when the person paused the agent or
// interrupted it with a comment. Aborting a session sends no final event,
// so without this the run stays "running" forever and is later mistaken
// for a crash or a completed reply.
export async function finalizeStoppedRun(
  backlog: BacklogRuns,
  story: UserStory,
  message: string
): Promise<UserStory | undefined> {
  const current = await backlog.loadDetail(story)
  const run =
    runningAgentRunsForStory(current).find(
      (item) => item.id === current.activeAgentRunId
    ) ?? runningAgentRunsForStory(current).at(-1)
  if (!run) return undefined
  return backlog.finalizeAgentRun(current, run, {
    activities: [],
    agentLastError: null,
    agentLastEvent: message,
    completedAt: new Date().toISOString(),
    outcome: "paused",
    status: "cancelled",
  })
}
