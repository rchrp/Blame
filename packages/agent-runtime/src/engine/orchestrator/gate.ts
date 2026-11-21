// The queue's gate for an epic's stories (the story service's `holds`), and
// what of the epic will not start by itself. Synchronous: the story service
// asks while it pumps, so it reads only what is already in memory (the
// state file once read, the epics as last read, the queue's waits).

import type {
  Epic,
  StoryEpicHold,
  StoryWaitReason,
  StoryWaiting,
} from "../protocol.js";
import { storyDisplayId, type HostStory } from "../stories/story.js";
import { waitsForPerson } from "./board.js";
import type { EpicEntry } from "./state.js";

// A start that keeps failing this long is the person's to fix (three tries
// at the queue's 30 s): the orchestrator is told and may not sleep on it.
export const stuckStartMs = 90_000;

/** What an entry says the epic spent (micro-USD): stories and conversation. */
export function keptSpend(entry: EpicEntry) {
  let total = entry.orchestrator?.microUsd ?? 0;
  for (const sessions of Object.values(entry.spend))
    for (const spent of Object.values(sessions)) total += spent.microUsd;
  return total;
}

/** The epic's budget is spent, from what is kept (never only in memory). */
export function budgetSpent(epic: Epic, entry: EpicEntry) {
  const budget = epic.settings.budgetMicroUsd;
  return (
    typeof budget === "number" &&
    Number.isFinite(budget) &&
    keptSpend(entry) >= budget
  );
}

/**
 * Why the epic holds a queued story, if it does: its conversation runs on
 * another computer (or this computer has not read what it keeps yet), the
 * epic is not read yet, it is not active, or its budget is spent.
 */
export function epicHold(input: {
  story: Pick<HostStory, "epicId">;
  ready: boolean;
  entry: EpicEntry | undefined;
  epic: Epic | undefined;
}): StoryWaitReason | undefined {
  const epicId = input.story.epicId;
  if (!epicId) return undefined;
  const hold = (why: StoryEpicHold): StoryWaitReason => ({
    kind: "epic",
    epicId,
    hold: why,
  });
  if (!input.ready) return hold("unknown");
  if (!input.entry) return hold("elsewhere");
  if (!input.epic) return hold("unknown");
  if (input.epic.status !== "active") return hold("paused");
  if (input.entry.branchGone) return hold("branch");
  if (budgetSpent(input.epic, input.entry)) return hold("budget");
  return undefined;
}

/** The waits of the epic's queued stories that only the person ends, with the reason in words. */
export function blockedStories(
  stories: readonly HostStory[],
  waits: readonly StoryWaiting[],
  stuck: (storyId: string) => boolean,
) {
  const byId = new Map(waits.map((wait) => [wait.storyId, wait.reason]));
  return stories.flatMap((story) => {
    const reason = byId.get(story.id);
    if (story.status !== "ready" || !reason) return [];
    const blocked =
      waitsForPerson(reason) || (reason.kind === "error" && stuck(story.id));
    return blocked
      ? [
          {
            storyId: story.id,
            number: storyDisplayId(story),
            title: story.title,
            reason: waitWords(reason),
          },
        ]
      : [];
  });
}

/** A queue's wait in a few words, for the orchestrator and the screen. */
export function waitWords(reason: StoryWaitReason): string {
  switch (reason.kind) {
    case "error":
      return `its start keeps failing: ${reason.message}`;
    case "epic":
      return {
        paused: "the epic is paused",
        budget: "the epic's budget is spent",
        elsewhere: "the epic runs on another computer",
        direct:
          "the project has no working preview environment (an epic's story never runs Direct)",
        branch:
          "the epic's branch is gone, and stories were already merged into it",
        unknown: "the epic is not read yet",
      }[reason.hold];
    case "dependency-dropped":
      return "a story it starts after was rejected or deleted";
    case "dependencies":
      return "it starts after stories not merged yet";
    case "no-model":
      return "no model is chosen";
    case "signed-out":
      return "the person is signed out";
    case "no-project":
      return "the project is not open on this computer";
    case "needs-runtime":
      return "the Blame Runtime must be installed or repaired";
    case "runtime":
      return "the Blame Runtime is starting";
    case "initialization":
      return "the preview environment is being prepared";
    case "cloud-without-premium":
      return "Cloud Preview needs Premium";
    case "host-dependencies":
      return "a tool it needs is missing on this computer";
    case "git-identity":
      return "Git has no name and email";
  }
}
