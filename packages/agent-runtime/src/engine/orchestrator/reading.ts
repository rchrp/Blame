// One look at an epic: its stories' sessions read once each (only those
// this computer runs and at work: another computer's is never read), what
// the epic spent, and the story turns that ended and that no wake told the
// orchestrator yet.

import type {
  EngineSessionStatus,
  Epic,
  EpicSpend,
  EpicStorySpend,
  OrchestratorWakeStory,
} from "../protocol.js";
import type { StoryService } from "../stories/service.js";
import type { HostStory } from "../stories/story.js";
import { wakeStory } from "./board.js";
import { turnKey, type ConversationView } from "./conversation.js";
import type { EpicEntry, OrchestratorState } from "./state.js";

export class EpicReading {
  readonly epic: Epic;
  readonly entry: EpicEntry | undefined;
  readonly conversation: ConversationView | undefined;
  private readonly stories: StoryService;
  private readonly state: OrchestratorState;
  private readonly statuses = new Map<
    string,
    Promise<EngineSessionStatus | undefined>
  >();

  constructor(input: {
    epic: Epic;
    entry: EpicEntry | undefined;
    conversation: ConversationView | undefined;
    stories: StoryService;
    state: OrchestratorState;
  }) {
    this.epic = input.epic;
    this.entry = input.entry;
    this.conversation = input.conversation;
    this.stories = input.stories;
    this.state = input.state;
  }

  /** The epic's stories, as the story service last read them. */
  epicStories(): HostStory[] {
    return this.stories.epicStories(this.epic.id);
  }

  /** A story's session, read once per look; undefined when it is not this computer's to read. */
  status(storyId: string) {
    let status = this.statuses.get(storyId);
    if (!status) {
      status = this.stories.storyStatus(storyId).catch(() => undefined);
      this.statuses.set(storyId, status);
    }
    return status;
  }

  /** What the epic spent: its orchestrator's records and each story's (kept once read). */
  async spend(): Promise<EpicSpend> {
    const cached = structuredClone(this.entry?.spend ?? {});
    for (const story of this.epicStories()) {
      const status = await this.status(story.id);
      if (!status?.exists || status.spentMicroUsd === undefined) continue;
      const sessions = (cached[story.id] ??= {});
      const known = sessions[status.session];
      if (known && known.microUsd >= status.spentMicroUsd) continue;
      sessions[status.session] = {
        microUsd: status.spentMicroUsd,
        unpriced: status.unpricedRequests ?? 0,
      };
    }
    const orchestrator = this.conversation
      ? {
          microUsd: this.conversation.spentMicroUsd,
          unpriced: this.conversation.unpricedRequests,
        }
      : this.entry?.orchestrator;
    if (this.entry)
      await this.state.change(this.epic.id, (entry) => {
        entry.spend = cached;
        if (orchestrator) entry.orchestrator = orchestrator;
      });
    const stories: EpicStorySpend[] = Object.entries(cached).map(
      ([storyId, sessions]) => ({
        storyId,
        microUsd: sum(Object.values(sessions).map((item) => item.microUsd)),
        unpricedRequests: sum(
          Object.values(sessions).map((item) => item.unpriced),
        ),
      }),
    );
    const storiesMicroUsd = sum(stories.map((item) => item.microUsd));
    const orchestratorMicroUsd = orchestrator?.microUsd ?? 0;
    const totalMicroUsd = storiesMicroUsd + orchestratorMicroUsd;
    const budget = this.epic.settings.budgetMicroUsd;
    const hasBudget = typeof budget === "number" && Number.isFinite(budget);
    return {
      orchestratorMicroUsd,
      storiesMicroUsd,
      totalMicroUsd,
      ...(hasBudget
        ? {
            budgetMicroUsd: budget,
            remainingMicroUsd: Math.max(0, budget - totalMicroUsd),
          }
        : {}),
      spent: hasBudget && totalMicroUsd >= budget,
      unpricedRequests:
        sum(stories.map((item) => item.unpricedRequests)) +
        (orchestrator?.unpriced ?? 0),
      stories,
    };
  }

  /**
   * The story turns no wake carried: what the story service told (kept
   * until a wake carries it), and the ended turns of the sessions of the
   * epic's stories this computer runs, for a telling a crash lost. A story
   * its agent still works on is left for its end to be settled first.
   */
  async unreported(): Promise<OrchestratorWakeStory[]> {
    const reported = new Set([
      ...(this.conversation?.reported ?? []),
      ...(this.entry?.heard ?? []),
    ]);
    const found = new Map<string, OrchestratorWakeStory>();
    for (const { story } of this.entry?.pending ?? []) {
      const key = turnKey(story.session, story.turn);
      if (!reported.has(key)) found.set(key, story);
    }
    for (const story of this.epicStories()) {
      if (story.agentStatus === "Running") continue;
      const status = await this.status(story.id);
      if (!status?.exists) continue;
      for (const ended of status.endedTurns ?? []) {
        const key = turnKey(status.session, ended.turn);
        if (reported.has(key) || found.has(key)) continue;
        found.set(key, wakeStory(story, status.session, ended));
      }
    }
    // What a wake already carried (it went, then Blame quit) is not kept.
    if (
      this.entry?.pending.some(({ story }) =>
        reported.has(turnKey(story.session, story.turn)),
      )
    )
      await this.state.change(this.epic.id, (entry) => {
        entry.pending = entry.pending.filter(
          ({ story }) => !reported.has(turnKey(story.session, story.turn)),
        );
      });
    return [...found.values()];
  }

  /**
   * These ended turns are known to the orchestrator without a wake (its
   * board or a report showed them, or the epic's pause made them): no wake
   * repeats them. Exactly these, nothing read since.
   */
  async markHeard(stories: ReadonlyArray<{ session: string; turn: string }>) {
    if (!this.entry || !stories.length) return;
    const keys = new Set(
      stories.map((story) => turnKey(story.session, story.turn)),
    );
    await this.state.change(this.epic.id, (entry) => {
      entry.heard = [...new Set([...(entry.heard ?? []), ...keys])];
      entry.pending = entry.pending.filter(
        ({ story }) => !keys.has(turnKey(story.session, story.turn)),
      );
    });
  }
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
