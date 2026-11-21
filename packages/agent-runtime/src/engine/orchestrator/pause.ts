// Pause all, done by the host (docs/orchestrator.md, "The epic"): when the
// epic goes `paused`, the agents of its stories at work are paused and the
// orchestrator's own turn is cut, and what was stopped is kept; nothing
// starts and nothing wakes it meanwhile. When it is `active` again exactly
// those agents resume, and the orchestrator's turn if the pause cut it. A
// story the person paused, or a turn the person stopped, is not the
// pause's: it stays as it is.

import type { StoryService } from "../stories/service.js";
import type { ConversationView } from "./conversation.js";
import type { EpicReading } from "./reading.js";
import type { EpicEntry, OrchestratorState } from "./state.js";

export type PauseHost = {
  stories: StoryService;
  state: OrchestratorState;
  /** Cuts the conversation's turn for the pause (not the person's stop). */
  interrupt(session: string): Promise<void>;
  report(error: unknown): void;
};

/** Stops what the epic runs; again on later looks for a story its start was in flight for. */
export async function pauseEpic(
  host: PauseHost,
  reading: EpicReading,
  entry: EpicEntry,
  conversation: ConversationView,
) {
  const known = entry.pause;
  const stopped = new Set(known?.stories ?? []);
  const starting = new Set(host.stories.queueState().starting);
  const awaited = new Set(known ? (known.awaiting ?? []) : starting);
  for (const story of reading.epicStories()) {
    const first = !known;
    const running =
      story.status === "in-progress" && story.agentStatus === "Running";
    // Running when the pause came, or whose start was in flight then.
    if (!running || stopped.has(story.id)) continue;
    if (!first && !awaited.has(story.id)) continue;
    try {
      await host.stories.pause(story.id);
      stopped.add(story.id);
      awaited.delete(story.id);
    } catch (error) {
      host.report(error);
    }
  }
  let turn = known?.turn ?? false;
  if (!known && (conversation.running || conversation.queued.length)) {
    await host.interrupt(entry.session);
    turn = true;
  }
  await host.state.change(reading.epic.id, (item) => {
    item.pause = {
      stories: [...stopped],
      turn,
      ...(awaited.size ? { awaiting: [...awaited] } : {}),
    };
  });
}

/**
 * Resumes what the pause stopped: each story still paused where the pause
 * left it. The turns the pause cut are not news for the orchestrator: no
 * wake tells them. Its own cut turn goes on through the host's resume.
 */
export async function resumeEpic(host: PauseHost, reading: EpicReading) {
  const pause = reading.entry?.pause;
  if (!pause) return;
  const cut = new Set(pause.stories);
  const told = (await reading.unreported()).filter(
    (story) => cut.has(story.storyId) && story.outcome === "interrupted",
  );
  await reading.markHeard(told);
  for (const story of reading.epicStories()) {
    if (!cut.has(story.id)) continue;
    if (story.status !== "in-progress" || story.agentStatus !== "Paused")
      continue;
    await host.stories.resume(story.id).catch(host.report);
  }
  await host.state.change(reading.epic.id, (item) => {
    delete item.pause;
  });
}
