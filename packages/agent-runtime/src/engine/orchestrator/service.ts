// The orchestrator in the engine host (docs/orchestrator.md): an epic's
// conversation, its branch, its tools, and what wakes it. It sleeps while
// the stories it started work; the host writes to it (a wake, never the
// person's message) when no story of the epic works any more, when a story
// another one starts after ended, when Blame stopped while it worked, or
// when it waits with nothing left that works or can start.
//
// The truth is in the records: what a wake told is in the conversation's
// own records, what a story's agent did in its session's. What the story
// service tells (`onTurnEnded`) is kept here until a wake carries it, and
// the sessions of the epic's stories this computer runs are read again on
// every look, so a telling lost in a crash is found there. Every look at an
// epic runs one at a time: on a story's ended turn, the end of an
// orchestrator turn, a window's change of the epic, a sign-in, and every
// minute.

import type { EngineClient, HostParamsOf } from "@blame/engine-client";
import type { ApiConnection, ModelRecommendations } from "../../types.js";
import type {
  EngineHostEvent,
  EngineHostInput,
  EngineHostMethod,
  EngineHostResult,
  EngineModelChoice,
  Epic,
  EpicState,
  OrchestratorSettings,
  OrchestratorWake,
  StoryTurnEnded,
} from "../protocol.js";
import { orchestratorWakeText } from "../protocol.js";
import type { ResolvedOrchestratorSettings } from "../purposes/orchestrator.js";
import type { StoryService } from "../stories/service.js";
import { parseStory, type HostStory } from "../stories/story.js";
import type { ClientTool } from "../tool.js";
import {
  epicCounts,
  epicHasWork,
  wakeDue,
  waitsForPerson,
  wakeStory,
} from "./board.js";
import {
  currentBranch,
  ensureBranch,
  newEpicBranch,
  type GitRun,
} from "./branch.js";
import {
  ConversationReader,
  conversationState,
  turnKey,
  type ConversationView,
} from "./conversation.js";
import { epicApi } from "./epics.js";
import { EpicReading } from "./reading.js";
import { OrchestratorState } from "./state.js";
import type { EpicDesk } from "./actions.js";
import { orchestratorTools } from "./tools.js";

export type OrchestratorHost = {
  api(): ApiConnection | undefined;
  stories: StoryService;
  call<M extends EngineHostMethod>(
    method: M,
    input: EngineHostInput<M>,
  ): Promise<EngineHostResult<M>>;
  /** This computer's engine (an epic's conversation works in the project folder). */
  client(): Promise<EngineClient>;
  git?: GitRun;
  emit(event: EngineHostEvent): void;
  /** The ranking stories' models are chosen from; the providers list's by default. */
  ranking?(): Promise<ModelRecommendations>;
};

export type OrchestratorOptions = {
  /** Where the epics run here are kept (`state.ts`); in memory without it. */
  stateFile?: string;
  /** How often every epic is looked at again. */
  tickMs?: number;
};

type Check = { again: boolean; done: Promise<void> };

// A failed read of an epic is tried again after this long (the queue's gate).
const epicRetryMs = 30_000;
// The ranking stories' models come from, kept this long.
const recommendationsMs = 5 * 60_000;

export class Orchestrator {
  private readonly host: OrchestratorHost;
  private readonly state: OrchestratorState;
  private readonly conversations = new ConversationReader();
  /** The epics as last read (`null`: deleted). */
  private readonly epics = new Map<string, Epic | null>();
  private readonly loadingEpics = new Map<string, Promise<Epic | null>>();
  private readonly failedEpics = new Map<string, number>();
  /** Epics whose budget is spent: their queued stories are held. */
  private readonly spentEpics = new Set<string>();
  private readonly checks = new Map<string, Check>();
  private readonly published = new Map<string, string>();
  /** The epics whose conversation runs here (from the state file); undefined until read. */
  private local: Set<string> | undefined;
  /** Why the last wake of an epic could not be sent. */
  private readonly wakeErrors = new Map<string, string>();
  private recommendations:
    { at: number; value: Promise<ModelRecommendations> } | undefined;
  private readonly tickTimer: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(host: OrchestratorHost, options: OrchestratorOptions = {}) {
    this.host = host;
    this.state = new OrchestratorState(options.stateFile);
    // Attached before the service tells anything (it tells after a sync).
    host.stories.onTurnEnded((event) => void this.turnEnded(event));
    this.tickTimer = setInterval(
      () => void this.checkAll(),
      options.tickMs ?? 60_000,
    );
    this.tickTimer.unref?.();
    void this.state.all().then((entries) => {
      this.local = new Set([
        ...entries.map(([epicId]) => epicId),
        ...(this.local ?? []),
      ]);
      host.stories.retry();
    }, report);
  }

  // -------------------------------------------------------- host's hooks

  /** The epic read for the conversation's config (its model, title and branch). */
  async resolve(
    session: string,
    settings: OrchestratorSettings,
  ): Promise<ResolvedOrchestratorSettings> {
    const epic = await this.epic(settings.epicId, true);
    if (!epic) throw new Error("This epic no longer exists.");
    if (epic.projectId !== settings.projectId)
      throw new Error("This epic belongs to another project.");
    const model = this.orchestratorModel(epic, settings.model);
    if (!model)
      throw new Error(
        "Choose the orchestrator's model in the epic's settings, or an agent model for the account.",
      );
    const entry = await this.state.get(epic.id);
    if (entry?.session === session)
      await this.state.change(epic.id, (item) => {
        item.settings = settings;
      });
    return {
      ...settings,
      resolved: {
        model,
        epic: {
          title: epic.title,
          goal: epic.goal,
          branch: epic.branch,
          targetBranch: epic.targetBranch,
        },
      },
    };
  }

  /**
   * Before the epic's conversation is created: its branch made from its
   * target branch (the project folder's current one when it names none),
   * both written to the epic with the session, and the epic run here.
   */
  async prepareSession(session: string, settings: OrchestratorSettings) {
    const epics = epicApi(this.connection());
    const epic = await epics.get(settings.epicId);
    if (epic.projectId !== settings.projectId)
      throw new Error("This epic belongs to another project.");
    if (epic.engineSessionId && epic.engineSessionId !== session) {
      const [status] = await this.host.call("status", {
        sessions: [epic.engineSessionId],
      });
      if (status?.exists)
        throw new Error("This epic already has its conversation.");
    }
    const git = this.git();
    const root = settings.workspace.root;
    const targetBranch = epic.targetBranch ?? (await currentBranch(git, root));
    const branch =
      epic.branch ??
      (await newEpicBranch(git, root, {
        title: epic.title,
        epicId: epic.id,
        taken: (await epics.list(epic.projectId))
          .filter((other) => other.id !== epic.id)
          .flatMap((other) => (other.branch ? [other.branch] : [])),
      }));
    // Written before the branch is made: a quit between the two leaves a
    // name the next look makes, never a branch no epic names.
    const updated =
      epic.branch === branch &&
      epic.targetBranch === targetBranch &&
      epic.engineSessionId === session
        ? epic
        : await epics.update(epic.id, {
            branch,
            targetBranch,
            engineSessionId: session,
          });
    this.epics.set(epic.id, updated);
    await ensureBranch(git, root, branch, targetBranch);
    await this.state.register(epic.id, {
      projectId: epic.projectId,
      session,
    });
    (this.local ??= new Set()).add(epic.id);
    await this.state.change(epic.id, (entry) => {
      entry.settings = settings;
      entry.stopped = false;
    });
  }

  /** A turn of a session started or every turn ended (the host's activity). */
  async onActivity(event: { session: string; running: boolean }) {
    const epicId = await this.state.bySession(event.session);
    if (!epicId) return;
    if (event.running)
      await this.state.change(epicId, (entry) => {
        entry.stopped = false;
      });
    void this.schedule(epicId);
  }

  /** The person stops the conversation's turn: it is not resumed after. */
  async interrupted(session: string) {
    const epicId = await this.state.bySession(session);
    if (epicId)
      await this.state.change(epicId, (entry) => {
        entry.stopped = true;
      });
  }

  /**
   * Answers the engine's approval request for the orchestrator's tools
   * that start work or merge: allowed at once unless the epic asks before
   * launching; then `create_stories` (unless every story is held),
   * `update_story` when it queues and `approve_story` wait for the person.
   */
  async approval(
    params: HostParamsOf<"host/approval">,
  ): Promise<"approved" | undefined> {
    const epicId = await this.state.bySession(params.session);
    if (!epicId) return undefined;
    const epic =
      (await this.epic(epicId, true).catch(() => undefined)) ??
      this.epics.get(epicId);
    if (!epic?.settings.askBeforeLaunch) return "approved";
    const input = (params.input ?? {}) as Record<string, unknown>;
    if (params.tool.name === "create_stories") {
      const stories = Array.isArray(input.stories) ? input.stories : [];
      if (
        stories.every((story) => (story as { hold?: unknown })?.hold === true)
      )
        return "approved";
    }
    if (params.tool.name === "update_story" && input.queue !== true)
      return "approved";
    return undefined;
  }

  /** The tools of an epic's conversation, bound to its epic. */
  tools(session: string, epicId: string): ClientTool<never>[] {
    return orchestratorTools(this.desk(session, epicId));
  }

  /**
   * The story service's gate: a queued story of an epic that is paused,
   * over, or whose budget is spent does not start, and neither does one of
   * an epic whose conversation runs on another computer (only the computer
   * that runs a story hears of its turns, and the orchestrator is woken
   * there). An epic not read yet holds its stories until it is.
   */
  holds(story: HostStory): boolean {
    const epicId = story.epicId;
    if (!epicId) return false;
    const epic = this.epics.get(epicId);
    if (epic === null) return false;
    if (!this.local?.has(epicId)) return true;
    if (!epic) {
      if (Date.now() - (this.failedEpics.get(epicId) ?? 0) > epicRetryMs)
        void this.epic(epicId, true)
          .then(() => this.host.stories.retry())
          .catch(() => this.failedEpics.set(epicId, Date.now()));
      return true;
    }
    return epic.status !== "active" || this.spentEpics.has(epicId);
  }

  /** A queued story that will not start by itself: held, or waiting for the person. */
  blocked(story: HostStory): boolean {
    if (this.holds(story)) return true;
    const wait = this.host.stories
      .queueState()
      .waiting.find((item) => item.storyId === story.id);
    return waitsForPerson(wait?.reason);
  }

  /** Signed in: every epic run here is looked at. */
  connected() {
    void this.checkAll();
  }

  /** What the screen shows of an epic. */
  async epicState(epicId: string): Promise<EpicState> {
    await this.schedule(epicId);
    return this.publish(await this.reading(epicId));
  }

  /** The window changed the epic: read again, its stories held or let go, the orchestrator woken if due. */
  async changed(epicId: string): Promise<EpicState> {
    const before = this.epics.get(epicId);
    const epic = await this.epic(epicId, true);
    // Resumed after a pause: a turn the pause stopped goes on.
    if (before?.status === "paused" && epic?.status === "active")
      await this.state.change(epicId, (entry) => {
        entry.stopped = false;
      });
    this.host.stories.retry();
    return this.epicState(epicId);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.tickTimer);
  }

  // ------------------------------------------------------------ waking

  private async turnEnded(event: StoryTurnEnded) {
    try {
      let story: HostStory;
      try {
        story = parseStory(event.story);
      } catch {
        story = await this.host.stories.read(event.storyId);
      }
      const epicId = story.epicId;
      if (!epicId || !(await this.state.get(epicId))) return;
      const told = wakeStory(story, event.session, {
        turn: event.turn,
        outcome: event.outcome,
        reply: event.lastReply,
      });
      await this.state.change(epicId, (entry) => {
        const key = turnKey(event.session, event.turn);
        if (
          !entry.pending.some(
            (item) => turnKey(item.story.session, item.story.turn) === key,
          )
        )
          entry.pending.push({ story: told });
        if (event.spentMicroUsd !== undefined) {
          const sessions = (entry.spend[story.id] ??= {});
          const known = sessions[event.session]?.microUsd ?? 0;
          if (event.spentMicroUsd >= known)
            sessions[event.session] = {
              microUsd: event.spentMicroUsd,
              unpriced: event.unpricedRequests ?? 0,
            };
        }
      });
      await this.schedule(epicId);
    } catch (error) {
      report(error);
    }
  }

  private async checkAll() {
    if (this.stopped || !this.host.api()) return;
    for (const [epicId] of await this.state.all())
      await this.schedule(epicId).catch(report);
  }

  /** Looks at the epic, one look at a time; asked again while it runs, once more after. */
  private schedule(epicId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const running = this.checks.get(epicId);
    if (running) {
      running.again = true;
      return running.done;
    }
    const check: Check = { again: false, done: Promise.resolve() };
    this.checks.set(epicId, check);
    check.done = (async () => {
      try {
        do {
          check.again = false;
          await this.check(epicId).catch(report);
        } while (check.again && !this.stopped);
      } finally {
        this.checks.delete(epicId);
      }
    })();
    return check.done;
  }

  private async check(epicId: string) {
    const entry = await this.state.get(epicId);
    if (!entry || !this.host.api()) return;
    const epic = await this.epic(epicId, true);
    // Deleted with its conversation: nothing to wake any more.
    if (!epic) return this.state.forget(epicId);
    // Until its stories are read, what works is not known.
    if (!this.host.stories.loaded(epic.projectId)) return;
    const client = await this.host.client();
    const conversation = await this.conversations.read(client, entry.session);
    const reading = this.lookAt(epic, entry, conversation);
    await this.publish(reading);
    if (epic.status !== "active" || !conversation.exists) return;
    if (conversation.running) return;
    // A message that waited through a quit goes on now.
    const queued = conversation.queued[0];
    if (queued) {
      await this.host.call("promote", { session: entry.session, turn: queued });
      return;
    }
    const { state } = conversationState(conversation, entry.stopped === true);
    if (state === "idle" || state === "asking" || state === "stopped") return;
    const unreported = await reading.unreported();
    const stories = reading.epicStories();
    const starting = this.starting();
    const cut =
      conversation.last?.outcome.status === "interrupted" && !entry.stopped;
    const reason: OrchestratorWake["reason"] | undefined = cut
      ? "resumed"
      : wakeDue(stories, starting, unreported)
        ? "stories"
        : state === "waiting" &&
            !unreported.length &&
            !epicHasWork(stories, starting, (story) =>
              this.blocked(story as HostStory),
            )
          ? "idle"
          : undefined;
    if (!reason) return;
    const spend = await reading.spend();
    await this.wake(epicId, entry.session, {
      reason,
      stories: unreported,
      board: epicCounts(stories, starting),
      ...(spend.budgetMicroUsd !== undefined
        ? {
            budget: {
              spent: spend.spent,
              remainingMicroUsd: spend.remainingMicroUsd,
            },
          }
        : {}),
    });
  }

  /**
   * The host's message to the conversation, with the settings a window
   * last sent (the epic's model may have changed). Once the engine has it,
   * the turns it carries are in the records: the kept copies go.
   */
  private async wake(epicId: string, session: string, wake: OrchestratorWake) {
    const settings = (await this.state.get(epicId))?.settings;
    try {
      await this.host.call("send", {
        session,
        message: { text: "", context: orchestratorWakeText(wake) },
        delivery: "turn",
        ...(settings
          ? { settings: { purpose: "orchestrator", settings } }
          : {}),
      });
      this.wakeErrors.delete(epicId);
    } catch (error) {
      // Shown on the epic; tried again on the next look (each minute).
      this.wakeErrors.set(
        epicId,
        `The orchestrator could not be woken: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    const told = new Set(
      wake.stories.map((story) => turnKey(story.session, story.turn)),
    );
    await this.state.change(epicId, (entry) => {
      entry.pending = entry.pending.filter(
        ({ story }) => !told.has(turnKey(story.session, story.turn)),
      );
    });
  }

  // ------------------------------------------------------------ reading

  /** The epic, from the API when `fresh` (or not read yet), else as last read. */
  async epic(epicId: string, fresh = false): Promise<Epic | null> {
    const known = this.epics.get(epicId);
    if (!fresh && known !== undefined) return known;
    let loading = this.loadingEpics.get(epicId);
    if (!loading) {
      loading = (async () => {
        try {
          const epic = await epicApi(this.connection()).get(epicId);
          this.epics.set(epicId, epic);
          this.failedEpics.delete(epicId);
          return epic;
        } catch (error) {
          if (/404|not found/i.test(String(error))) {
            this.epics.set(epicId, null);
            return null;
          }
          throw error;
        }
      })().finally(() => this.loadingEpics.delete(epicId));
      this.loadingEpics.set(epicId, loading);
    }
    const before = known?.status;
    const epic = await loading;
    if (epic && before !== undefined && before !== epic.status)
      this.host.stories.retry();
    return epic;
  }

  /** Reads the epic's conversation (when it runs here) for one look. */
  async reading(epicId: string): Promise<EpicReading> {
    const epic = await this.epic(epicId, true);
    if (!epic) throw new Error("This epic no longer exists.");
    const entry = await this.state.get(epicId);
    let conversation: ConversationView | undefined;
    if (entry)
      conversation = await this.conversations.read(
        await this.host.client(),
        entry.session,
      );
    return this.lookAt(epic, entry, conversation);
  }

  private lookAt(
    epic: Epic,
    entry: Awaited<ReturnType<OrchestratorState["get"]>>,
    conversation: ConversationView | undefined,
  ) {
    return new EpicReading({
      epic,
      entry,
      conversation,
      stories: this.host.stories,
      state: this.state,
    });
  }

  /** The epic's state, told to the windows when it changed; the queue's gate follows its budget. */
  private async publish(reading: EpicReading): Promise<EpicState> {
    const { epic, entry, conversation } = reading;
    const spend = await reading.spend();
    const wasSpent = this.spentEpics.has(epic.id);
    if (spend.spent) this.spentEpics.add(epic.id);
    else this.spentEpics.delete(epic.id);
    if (wasSpent !== spend.spent) this.host.stories.retry();
    const looked = conversationState(conversation, entry?.stopped === true);
    const { state } = looked;
    const error = looked.error ?? this.wakeErrors.get(epic.id);
    const endTurn = conversation?.last?.endTurn;
    const unreported = entry ? (await reading.unreported()).length : 0;
    const epicState: EpicState = {
      epicId: epic.id,
      ...((entry?.session ?? epic.engineSessionId)
        ? { session: entry?.session ?? epic.engineSessionId! }
        : {}),
      conversation: state,
      ...(error ? { error } : {}),
      ...(state === "asking" && endTurn?.question
        ? {
            question: {
              text: endTurn.question,
              options: endTurn.options ?? [],
            },
          }
        : {}),
      ...(state === "finished" && endTurn?.summary
        ? { summary: endTurn.summary }
        : {}),
      unreported,
      spend,
    };
    const serialized = JSON.stringify(epicState);
    if (this.published.get(epic.id) !== serialized) {
      this.published.set(epic.id, serialized);
      this.host.emit({ type: "epic", epicId: epic.id, state: epicState });
    }
    return epicState;
  }

  private starting() {
    return new Set(this.host.stories.queueState().starting);
  }

  /** The epic's model, else the one a window sent, else the account's agent model. */
  orchestratorModel(
    epic: Epic,
    sent?: EngineModelChoice,
  ): EngineModelChoice | undefined {
    const own = epic.settings.orchestratorModel;
    if (own?.providerId && own.modelId) return own;
    if (sent?.providerId && sent.modelId) return sent;
    return this.fallbackModel();
  }

  fallbackModel(): EngineModelChoice | undefined {
    const agent = this.host.stories.preferences()?.agentModel;
    if (!agent) return undefined;
    const { maxInputTokens: _, ...model } = agent;
    void _;
    return model;
  }

  /** The ranking the stories' models are chosen from (the providers list's). */
  modelRanking(): Promise<ModelRecommendations> {
    if (this.host.ranking) return this.host.ranking();
    const known = this.recommendations;
    if (known && Date.now() - known.at < recommendationsMs) return known.value;
    const value = this.host
      .call("providers", { refresh: false })
      .then((list) => list.recommendations);
    this.recommendations = { at: Date.now(), value };
    value.catch(() => {
      if (this.recommendations?.value === value)
        this.recommendations = undefined;
    });
    return value;
  }

  private desk(session: string, epicId: string): EpicDesk {
    return {
      epicId,
      session,
      orchestrator: this,
      stories: this.host.stories,
      state: this.state,
      git: this.host.git,
      starting: () => this.starting(),
      holds: (story) => this.holds(story),
      blocked: (story) => this.blocked(story),
    };
  }

  private connection() {
    const connection = this.host.api();
    if (!connection) throw new Error("Sign in to run an epic.");
    return connection;
  }

  private git(): GitRun {
    const git = this.host.git;
    if (!git) throw new Error("Git is not available to the orchestrator here.");
    return git;
  }
}

function report(error: unknown) {
  console.error(
    "Orchestrator:",
    error instanceof Error ? error.message : String(error),
  );
}
