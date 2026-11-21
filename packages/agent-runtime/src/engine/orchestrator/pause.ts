// Pause all, done by the host (docs/orchestrator.md, "The epic"): when the
// epic goes `paused`, the agents of its stories at work are paused and the
// orchestrator's turn running then is cut; nothing starts and nothing wakes
// it meanwhile. The person can still talk to it: a turn they start later
// runs (its acting tools refuse while the epic is paused). When it is
// `active` again exactly those agents resume, and the orchestrator's turn
// if the pause cut it.
//
// What the pause means to stop is written before it acts, and every step
// can run again (pausing a paused agent, cutting a turn that ended, resuming
// a story no longer paused do nothing): a failure or a quit part way is
// taken up by the next look. A story the person pauses, resumes, messages,
// discards or sends back by hand in between is the person's from then on
// (`Orchestrator.touched`): the resume leaves it as it is.

import type { HostStory } from "../stories/story.js";
import type { StoryService } from "../stories/service.js";
import type { ConversationView } from "./conversation.js";
import type { EpicReading } from "./reading.js";
import type { EpicEntry, EpicPause, OrchestratorState } from "./state.js";

export type PauseHost = {
  stories: StoryService;
  state: OrchestratorState;
  /** Cuts the conversation's turn for the epic's pause (not the person's stop). */
  interrupt(session: string): Promise<void>;
  report(error: unknown): void;
};

/** How far the pause is: everything it meant to stop is stopped, or not yet (and why). */
export type PauseProgress = { done: boolean; error?: string };

const running = (story: HostStory | undefined) =>
  story?.status === "in-progress" && story.agentStatus === "Running";

/** Stops what the epic runs, as far as it can now; the next look goes on. */
export async function pauseEpic(
  host: PauseHost,
  reading: EpicReading,
  entry: EpicEntry,
  conversation: ConversationView,
): Promise<PauseProgress> {
  const epicId = reading.epic.id;
  const stories = new Map(
    reading.epicStories().map((story) => [story.id, story]),
  );
  // Only the turn running when the pause came is cut, never a later one.
  const runningTurn = conversation.runningTurn;
  let pause = entry.pause;
  if (!pause || pause.phase === "resuming") {
    const starting = host.stories
      .queueState()
      .starting.filter((id) => stories.has(id));
    pause = {
      phase: "pausing",
      // A pause during a resume keeps what is still the pause's.
      stories: [
        ...new Set([
          ...(pause?.stories ?? []),
          ...[...stories.values()].filter(running).map((story) => story.id),
        ]),
      ],
      ...(starting.length ? { awaiting: starting } : {}),
      turn: (pause?.turn ?? false) || runningTurn !== undefined,
      ...((runningTurn ?? pause?.cut)
        ? { cut: runningTurn ?? pause?.cut }
        : {}),
    };
    const intended = pause;
    // Written before anything is stopped.
    await host.state.change(epicId, (item) => {
      item.pause = intended;
    });
  }
  const errors: string[] = [];
  const pausing = new Set(pause.stories);
  // A start that was in flight when the pause came is the pause's once it runs.
  const queue = new Set(host.stories.queueState().starting);
  const awaiting = (pause.awaiting ?? []).filter((id) => {
    if (running(stories.get(id))) {
      pausing.add(id);
      return false;
    }
    return queue.has(id);
  });
  for (const id of pausing) {
    if (!running(stories.get(id))) continue;
    await host.stories.pause(id).catch((error: unknown) => {
      errors.push(message(error));
      host.report(error);
    });
  }
  const cutting = pause.cut !== undefined && runningTurn === pause.cut;
  if (cutting)
    await host.interrupt(entry.session).catch((error: unknown) => {
      errors.push(message(error));
      host.report(error);
    });
  // Done once nothing it meant to stop still runs (a turn ends a moment
  // after it is interrupted: the look its end brings says so).
  const still =
    [...pausing].some((id) => running(stories.get(id))) ||
    awaiting.length > 0 ||
    cutting;
  const next: EpicPause = {
    phase: still ? "pausing" : "paused",
    stories: [...pausing],
    ...(awaiting.length ? { awaiting } : {}),
    turn: pause.turn,
    ...(pause.cut ? { cut: pause.cut } : {}),
  };
  await host.state.change(epicId, (item) => {
    item.pause = next;
  });
  return {
    done: !still,
    ...(errors.length ? { error: errors.join(" ") } : {}),
  };
}

/**
 * Resumes what the pause stopped: each story still paused where the pause
 * left it. The turns the pause cut are not news for the orchestrator: no
 * wake tells them. Its own cut turn goes on through the host's resume
 * (`turn`), which keeps the pause until that wake is sent. Written ahead
 * as `resuming`, so a quit part way resumes the rest.
 */
export async function resumeEpic(
  host: PauseHost,
  reading: EpicReading,
): Promise<{ turn: boolean; done: boolean }> {
  const pause = reading.entry?.pause;
  if (!pause) return { turn: false, done: true };
  const epicId = reading.epic.id;
  if (pause.phase !== "resuming")
    await host.state.change(epicId, (item) => {
      if (item.pause) item.pause = { ...item.pause, phase: "resuming" };
    });
  const cut = new Set(pause.stories);
  const told = (await reading.unreported()).filter(
    (story) => cut.has(story.storyId) && story.outcome === "interrupted",
  );
  await reading.markHeard(told);
  let done = true;
  for (const story of reading.epicStories()) {
    if (!cut.has(story.id)) continue;
    if (story.status !== "in-progress" || story.agentStatus !== "Paused")
      continue;
    await host.stories.resume(story.id).catch((error: unknown) => {
      done = false;
      host.report(error);
    });
  }
  return { turn: pause.turn, done };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A person acted on a story from a window (a message, a pause, a resume, a
 * discard…): it is theirs from then on, and no epic's pause or resume
 * touches it.
 */
export async function leaveToPerson(state: OrchestratorState, storyId: string) {
  for (const [epicId, entry] of await state.all()) {
    const pause = entry.pause;
    if (
      !pause?.stories.includes(storyId) &&
      !pause?.awaiting?.includes(storyId)
    )
      continue;
    await state.change(epicId, (item) => {
      if (!item.pause) return;
      item.pause = {
        ...item.pause,
        stories: item.pause.stories.filter((id) => id !== storyId),
        ...(item.pause.awaiting
          ? { awaiting: item.pause.awaiting.filter((id) => id !== storyId) }
          : {}),
      };
    });
  }
}
