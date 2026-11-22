// The epic's stories as the orchestrator's rules see them. Pure: which
// story works, which can still start by itself, when the host wakes the
// orchestrator, the board's counts, and an ended turn as a wake tells it.

import { unverifiedChecks, type TurnOutcome } from "@blame/engine-client";
import type {
  EpicBoardCounts,
  OrchestratorWakeStory,
  StoryWaitReason,
} from "../protocol.js";
import { storyDisplayId, type HostStory } from "../stories/story.js";

type Story = Pick<
  HostStory,
  "id" | "status" | "agentStatus" | "startsAfter" | "storyNumber" | "title"
>;

/** Its agent works now: a turn runs, it is being started, or merged. */
export function storyWorks(story: Story, starting: ReadonlySet<string>) {
  if (starting.has(story.id)) return true;
  return (
    (story.status === "in-progress" || story.status === "in-review") &&
    story.agentStatus === "Running"
  );
}

/**
 * A queued story that will start without the orchestrator: each story it
 * starts after is done, works, or will start itself. One that waits for a
 * story in review, paused, held in the backlog or rejected does not: that
 * needs the orchestrator's decision. A queued story held by its epic (paused,
 * its budget spent) does not either.
 */
export function storyCanStart(
  story: Story,
  stories: readonly Story[],
  starting: ReadonlySet<string>,
  held: (story: Story) => boolean = () => false,
  seen = new Set<string>(),
): boolean {
  if (story.status !== "ready" || held(story) || seen.has(story.id))
    return false;
  seen.add(story.id);
  const byId = new Map(stories.map((item) => [item.id, item]));
  return (story.startsAfter ?? []).every((id) => {
    const dependency = byId.get(id);
    if (!dependency) return false;
    if (dependency.status === "done") return true;
    return (
      storyWorks(dependency, starting) ||
      storyCanStart(dependency, stories, starting, held, seen)
    );
  });
}

// The waits of a queued story that only the person ends (or nothing does).
const personWaits = new Set<StoryWaitReason["kind"]>([
  "dependency-dropped",
  "no-project",
  "no-model",
  "signed-out",
  "needs-runtime",
  "cloud-without-premium",
  "host-dependencies",
  "git-identity",
]);

/** The queue says the story waits for the person: it does not start by itself. */
export function waitsForPerson(reason: StoryWaitReason | undefined) {
  if (reason?.kind === "epic") return reason.hold !== "unknown";
  return reason !== undefined && personWaits.has(reason.kind);
}

/** Something of the epic works or will start: the orchestrator may sleep. */
export function epicHasWork(
  stories: readonly Story[],
  starting: ReadonlySet<string>,
  held?: (story: Story) => boolean,
) {
  return stories.some(
    (story) =>
      storyWorks(story, starting) ||
      storyCanStart(story, stories, starting, held),
  );
}

/**
 * Whether the host wakes the orchestrator for these ended turns now: no
 * story of the epic works any more, or one of them is a story another
 * story of the epic (not done or rejected) starts after.
 */
export function wakeDue(
  stories: readonly Story[],
  starting: ReadonlySet<string>,
  ended: ReadonlyArray<{ storyId: string }>,
) {
  if (!ended.length) return false;
  if (!stories.some((story) => storyWorks(story, starting))) return true;
  const endedIds = new Set(ended.map(({ storyId }) => storyId));
  return stories.some(
    (story) =>
      story.status !== "done" &&
      story.status !== "discarded" &&
      (story.startsAfter ?? []).some((id) => endedIds.has(id)),
  );
}

export function epicCounts(
  stories: readonly Story[],
  starting: ReadonlySet<string>,
): EpicBoardCounts {
  const counts: EpicBoardCounts = {
    working: 0,
    queued: 0,
    held: 0,
    inReview: 0,
    paused: 0,
    merged: 0,
    rejected: 0,
  };
  for (const story of stories) {
    if (storyWorks(story, starting)) counts.working += 1;
    else if (story.status === "ready") counts.queued += 1;
    else if (story.status === "backlog") counts.held += 1;
    else if (story.status === "in-review") counts.inReview += 1;
    else if (story.status === "in-progress") counts.paused += 1;
    else if (story.status === "done") counts.merged += 1;
    else if (story.status === "discarded") counts.rejected += 1;
  }
  return counts;
}

/** The first lines of a reply, for a wake (the report has it whole). */
export function replyExcerpt(reply: string | undefined, lines = 6) {
  const text = reply?.trim();
  if (!text) return undefined;
  const kept = text.split("\n").slice(0, lines).join("\n");
  return kept.length > 800 ? `${kept.slice(0, 799)}…` : kept;
}

/** How a turn's outcome reads to the orchestrator: verified, the failing checks, the error. */
export function outcomeFacts(outcome: TurnOutcome | undefined) {
  const failing = outcome ? unverifiedChecks({ outcome }) : undefined;
  return {
    verified: outcome?.status === "completed",
    ...(failing ? { failingChecks: failing.split(", ") } : {}),
    ...(outcome?.status === "failed" ? { error: outcome.error.message } : {}),
    ...(outcome?.status === "limit_reached"
      ? { error: `It reached a limit (${outcome.limit}).` }
      : {}),
  };
}

/** One ended turn of a story, as a wake tells it. */
export function wakeStory(
  story: Pick<HostStory, "id" | "storyNumber" | "title" | "status">,
  session: string,
  ended: { turn: string; outcome?: TurnOutcome; reply?: string },
): OrchestratorWakeStory {
  const reply = replyExcerpt(ended.reply);
  return {
    storyId: story.id,
    number: storyDisplayId(story),
    title: story.title,
    session,
    turn: ended.turn,
    outcome: ended.outcome?.status ?? "interrupted",
    ...outcomeFacts(ended.outcome),
    status: story.status,
    ...(reply ? { reply } : {}),
  };
}

/**
 * What an `idle` wake tells: each story's state and each blocked story's
 * reason. The same again, after the same `wait`, is not told again
 * (`idleTold`): a story that started, the person's act, or another error
 * makes it differ.
 */
export function idleSignature(
  stories: ReadonlyArray<Pick<HostStory, "id" | "status" | "agentStatus">>,
  blocked: ReadonlyArray<{ storyId: string; reason: string }>,
) {
  return JSON.stringify([
    stories.map((story) => [story.id, story.status, story.agentStatus ?? null]),
    blocked.map((item) => [item.storyId, item.reason]),
  ]);
}

/** What an `idle` wake told: the `wait` it answered and the stories as they stood. */
export function idleTold(waitTurn: string | undefined, signature: string) {
  return `${waitTurn ?? ""}\n${signature}`;
}
