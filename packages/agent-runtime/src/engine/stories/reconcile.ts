// What a story's record should say, given what the engine says of its
// session: the one rule every path ends in (a turn's end, a start or a
// merge cut short by a failure or a quit, an event that never came). A
// story is never left Running with no turn running, nor In Progress with no
// agent to talk to.

import type { EngineSessionStatus } from "../protocol.js";
import {
  storyOutcomeUpdate,
  withTurnCounts,
  type HostStory,
  type StoryUpdate,
} from "./story.js";

export const lostConversationText =
  "The agent's conversation could not be found.";
export const mergeStoppedText =
  "Approve & Merge stopped before it finished. Approve again to merge the story.";

export type ReconcileDecision = {
  update?: StoryUpdate;
  /** The session never got a message: it goes, and the story starts again. */
  dropSession?: boolean;
};

/**
 * `status` is the engine's answer for the story's session (absent when it
 * has none). The caller holds the story's turn: no action of the service
 * runs on it meanwhile, so a Running in review is a merge that stopped.
 */
export function reconcileDecision(
  story: HostStory,
  status: EngineSessionStatus | undefined,
): ReconcileDecision {
  const working = story.status === "in-progress";
  if (!story.engineSessionId || !status) {
    // A start cut short before its session: back to the queue, its
    // worktree reused.
    if (working) return { update: { status: "ready", agentStatus: null } };
    if (story.status === "in-review" && story.agentStatus === "Running")
      return {
        update: { agentStatus: null, agentLastError: mergeStoppedText },
      };
    return story.agentStatus === "Running"
      ? { update: { agentStatus: null } }
      : {};
  }
  if (!status.exists) {
    if (working && story.agentStatus !== "Paused")
      return {
        update: { agentStatus: "Paused", agentLastError: lostConversationText },
      };
    return story.agentStatus === "Running"
      ? { update: { agentStatus: null } }
      : {};
  }
  const agentModels = withTurnCounts(story.agentModels, status.models);
  const counted = agentModels ? { agentModels } : {};
  if (status.running) {
    // A turn runs: the story works, a follow-up to a story in review too.
    const active = working || story.status === "in-review";
    if (active && (story.agentStatus !== "Running" || !working))
      return {
        update: { agentStatus: "Running", status: "in-progress", ...counted },
      };
    return {};
  }
  if (working && story.agentStatus !== "Paused") {
    // Its session never got its first message: the start stopped short.
    if (status.turns === 0)
      return {
        update: { status: "ready", agentStatus: null, engineSessionId: null },
        dropSession: true,
      };
    return {
      update: { ...storyOutcomeUpdate(story, status.lastOutcome), ...counted },
    };
  }
  if (story.status === "in-review" && story.agentStatus === "Running")
    return {
      update: {
        agentStatus: null,
        agentLastError: mergeStoppedText,
        ...counted,
      },
    };
  if (story.agentStatus === "Running")
    return { update: { agentStatus: null, ...counted } };
  return agentModels ? { update: { agentModels } } : {};
}
