import type {
  UserStory,
  UserStoryAgentRun,
  UserStoryAgentRunFinalization,
} from "@/components/backlog/data/backlog-data"
import { agentPersistenceEvent } from "../../components/backlog/data/agent-stream-coordinator.ts"
import { settleStoryRunStreams } from "../../components/backlog/data/agent-run-streams.ts"
import { runningAgentRunsForStory } from "./agent-run-liveness.ts"

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
  await settleStoryRunStreams(story.id)
  const current = await backlog.loadDetail(story)
  const run =
    runningAgentRunsForStory(current).find(
      (item) => item.id === current.activeAgentRunId
    ) ?? runningAgentRunsForStory(current).at(-1)
  if (!run) return undefined
  const completedAt = new Date().toISOString()
  return backlog.finalizeAgentRun(current, run, {
    activities: [],
    agentLastError: null,
    agentLastEvent: message,
    completedAt,
    outcome: "paused",
    persistenceEvent: agentPersistenceEvent(
      { createdAt: completedAt, payload: { reason: "aborted" }, type: "done" },
      {
        executionId: run.executionId ?? run.id,
        lastSequenceNumber: run.lastSequenceNumber,
        runId: run.id,
        sessionId: run.clineSessionId ?? current.clineSessionId ?? run.id,
      }
    ),
    status: "cancelled",
  })
}
