// Which queued stories start, and why the others wait. Pure: the story
// service applies it to the stories it holds. There is no cap on how many
// agents work at once: every story that can start, starts.

import type { ProjectInitialization } from "./api.js";
import { readyForAgent, type HostStory } from "./story.js";
import type { StoryRunMode, StoryWaitReason } from "../story-protocol.js";

/** The queued stories whose agent can start, oldest first. */
export function queuedStories(stories: readonly HostStory[]) {
  return stories
    .filter(readyForAgent)
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() -
        new Date(right.createdAt).getTime(),
    );
}

/**
 * Whether the stories a story starts after are done (merged). One that was
 * discarded or no longer exists means it never starts: that dependency
 * will not be done.
 */
export function dependencyWait(
  story: Pick<HostStory, "id" | "startsAfter">,
  projectStories: readonly Pick<HostStory, "id" | "status">[],
): StoryWaitReason | undefined {
  const ids = [...new Set(story.startsAfter ?? [])].filter(
    (id) => id !== story.id,
  );
  if (!ids.length) return undefined;
  const byId = new Map(projectStories.map((item) => [item.id, item]));
  const dropped = ids.filter((id) => {
    const dependency = byId.get(id);
    return !dependency || dependency.status === "discarded";
  });
  if (dropped.length) return { kind: "dependency-dropped", storyIds: dropped };
  const pending = ids.filter((id) => byId.get(id)?.status !== "done");
  return pending.length
    ? { kind: "dependencies", storyIds: pending }
    : undefined;
}

// A run that stopped reporting (Blame quit, a crash) must not hold stories
// back: after this long without news it counts as stopped.
const staleInitializationMs = 15 * 60_000;

/**
 * What a queued story does with the project's preview environment. Direct
 * stories need none. The others wait while it is prepared, and without
 * one (it failed, never ran, or stopped reporting) they run Direct instead
 * of waiting forever.
 */
export function initializationDecision(
  initialization: ProjectInitialization | null | undefined,
  mode: StoryRunMode,
  now = Date.now(),
): "start" | "wait" | "run-direct" {
  if (mode === "direct") return "start";
  if (initialization?.status === "done" && initialization.previewManifest)
    return "start";
  if (initialization?.status === "running") {
    const reportedAt = Date.parse(
      initialization.updatedAt ?? initialization.createdAt,
    );
    if (
      Number.isFinite(reportedAt) &&
      now - reportedAt <= staleInitializationMs
    )
      return "wait";
  }
  return "run-direct";
}

// Phases of the Blame Runtime during which a new Local Container story waits.
const runtimeBusyPhases = new Set([
  "checking",
  "stopped",
  "starting",
  "update-pending",
  "installing",
  "updating",
  "repairing",
]);

/**
 * Whether a story can start given the Blame Runtime: only Local Container
 * stories need it. A runtime that is starting or updating is waited for; a
 * missing or broken one must be installed or repaired first.
 */
export function runtimeWait(
  mode: StoryRunMode,
  phase: string,
): StoryWaitReason | undefined {
  if (mode !== "local-container") return undefined;
  if (phase === "ready" || phase === "unavailable") return undefined;
  if (runtimeBusyPhases.has(phase)) return { kind: "runtime", phase };
  return { kind: "needs-runtime", phase };
}

/** How long a story waits before the queue looks at it again by itself. */
export function retryDelay(reason: StoryWaitReason): number | undefined {
  switch (reason.kind) {
    // Settled by a change the service hears of (a story done, a sync).
    case "dependencies":
    case "dependency-dropped":
    case "no-project":
    case "no-model":
    case "signed-out":
      return undefined;
    case "initialization":
    case "runtime":
      return 5_000;
    default:
      return 30_000;
  }
}
