// After Blame quits mid-turn (agents stop with the app), the stories it
// left Running are settled from their records, once per session.

import type { EngineLocation } from "../protocol.js";
import type { StoryServiceHost } from "./service.js";
import {
  storyLocation,
  storyOutcomeUpdate,
  type HostStory,
  type StoryUpdate,
} from "./story.js";

export async function recoverStories(
  stories: readonly HostStory[],
  recovered: Set<string>,
  call: StoryServiceHost["call"],
  patch: (story: HostStory, update: StoryUpdate) => Promise<unknown>,
) {
  const left = stories.filter(
    (story) =>
      // In review, Running means Approve & Merge, not the agent.
      story.status === "in-progress" &&
      story.agentStatus === "Running" &&
      story.engineSessionId &&
      !recovered.has(story.engineSessionId),
  );
  for (const story of left) recovered.add(story.engineSessionId!);
  // Each engine answers for its own sessions (this computer's, the VM's).
  const byLocation = new Map<EngineLocation, HostStory[]>();
  for (const story of left) {
    const location = storyLocation(story.workspaceMode);
    byLocation.set(location, [...(byLocation.get(location) ?? []), story]);
  }
  const statuses = (
    await Promise.all(
      [...byLocation].map(([location, located]) =>
        call("status", {
          sessions: located.map((story) => story.engineSessionId!),
          location,
        }).catch(() => []),
      ),
    )
  ).flat();
  for (const status of statuses) {
    if (status.running) continue;
    const story = left.find((item) => item.engineSessionId === status.session);
    if (!story) continue;
    await patch(story, {
      ...storyOutcomeUpdate(story, status.lastOutcome),
      ...(status.exists
        ? {}
        : {
            agentStatus: "Paused" as const,
            agentLastError: "The agent's conversation could not be found.",
          }),
    }).catch(() => undefined);
  }
}
