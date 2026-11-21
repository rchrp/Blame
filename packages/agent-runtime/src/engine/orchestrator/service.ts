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
// minute. What is kept for an epic belongs to the API it was created
// through, and is never dropped because the API does not show the epic
// (another account, another deployment): only once it reads it discarded.

import type { EngineClient, HostParamsOf } from "@blame/engine-client";
import type { ApiConnection, ModelRecommendations } from "../../types.js";
import type {
  EngineHostInput,
  EngineHostMethod,
  EngineHostResult,
  EngineHostEvent,
  EngineMessage,
  EngineModelChoice,
  EngineSessionSettings,
  Epic,
  EpicState,
  OrchestratorSettings,
  OrchestratorWake,
  StoryTurnEnded,
  StoryWaitReason,
} from "../protocol.js";
import { orchestratorWakeText } from "../protocol.js";
import type { ResolvedOrchestratorSettings } from "../purposes/orchestrator.js";
import type { StoryService } from "../stories/service.js";
import { parseStory, type HostStory } from "../stories/story.js";
import type { ClientTool } from "../tool.js";
import type { EpicDesk } from "./actions.js";
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
  epicBranchProblem,
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
import { blockedStories, epicHold, stuckStartMs } from "./gate.js";
import { pauseEpic, resumeEpic } from "./pause.js";
import { EpicReading } from "./reading.js";
import { OrchestratorState, type EpicEntry } from "./state.js";
import { orchestratorTools } from "./tools.js";

export type OrchestratorHost = {
  api(): ApiConnection | undefined;
  stories: StoryService;
  call<M extends EngineHostMethod>(
    method: M,
    input: EngineHostInput<M>,
  ): Promise<EngineHostResult<M>>;
  /**
   * The host's own message to a conversation (a wake): the one path that
   * may write one, since `send` refuses a wake from a window. Resolves
   * once the engine has the message in its records.
   */
  write(input: {
    session: string;
    message: EngineMessage;
    settings?: EngineSessionSettings;
  }): Promise<void>;
  /** Cuts a conversation's turn for the epic's pause (not the person's stop). */
  interrupt(session: string): Promise<void>;
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
  /** For tests: how long a start keeps failing before the person is told. */
  stuckStartMs?: number;
};

type Check = { again: boolean; done: Promise<void> };

// An epic the API does not show (or did not answer for) is read again
// after this long, for the queue's gate.
const epicRetryMs = 30_000;
// Resumes in a row after cut turns, before the person is left to decide.
const maxResumes = 3;
// The ranking stories' models come from, kept this long.
const recommendationsMs = 5 * 60_000;
// The tools that start work or merge: the ones the person may be asked for.
const approvalTools = new Set([
  "create_stories",
  "update_story",
  "approve_story",
]);

export class Orchestrator {
  private readonly host: OrchestratorHost;
  private readonly state: OrchestratorState;
  private readonly conversations = new ConversationReader();
  /** The epics as last read from the API. */
  private readonly epics = new Map<string, Epic>();
  private readonly loadingEpics = new Map<string, Promise<Epic | undefined>>();
  /** When an epic could last not be read (not shown, or no answer). */
  private readonly unread = new Map<string, number>();
  private readonly checks = new Map<string, Check>();
  private readonly published = new Map<string, string>();
  /** Why the last wake of an epic could not be sent. */
  private readonly wakeErrors = new Map<string, string>();
  /** Resumes sent in a row with no turn ended through `end_turn` between them. */
  private readonly resumes = new Map<string, number>();
  /** Since when a queued story's start keeps failing, by story. */
  private readonly failing = new Map<string, number>();
  /** Epic branches being made, by project folder: two at once never pick one name. */
  private readonly preparing = new Map<string, Promise<unknown>>();
  private recommendations:
    { at: number; value: Promise<ModelRecommendations> } | undefined;
  private readonly tickTimer: ReturnType<typeof setInterval>;
  private readonly stuckMs: number;
  private stopped = false;

  constructor(host: OrchestratorHost, options: OrchestratorOptions = {}) {
    this.host = host;
    this.stuckMs = options.stuckStartMs ?? stuckStartMs;
    this.state = new OrchestratorState(options.stateFile);
    // Attached before the service tells anything (it tells after a sync).
    host.stories.onTurnEnded((event) => void this.turnEnded(event));
    this.tickTimer = setInterval(
      () => void this.checkAll(),
      options.tickMs ?? 60_000,
    );
    this.tickTimer.unref?.();
    // Until the file is read every epic story is held: the gate answers
    // from it from then on.
    void this.state.all().then(() => host.stories.retry(), report);
  }

  // -------------------------------------------------------- host's hooks

  /** The epic read for the conversation's config (its model, title and branch). */
  async resolve(
    session: string,
    settings: OrchestratorSettings,
  ): Promise<ResolvedOrchestratorSettings> {
    const epic = await this.epic(settings.epicId, true);
    if (!epic) throw new Error("This epic cannot be read from the account.");
    if (epic.projectId !== settings.projectId)
      throw new Error("This epic belongs to another project.");
    const entry = await this.state.get(epic.id);
    if (
      (epic.engineSessionId && epic.engineSessionId !== session) ||
      (entry && entry.session !== session)
    )
      throw new Error("This conversation is not this epic's.");
    const model = this.orchestratorModel(epic, settings.model);
    if (!model)
      throw new Error(
        "Choose the orchestrator's model in the epic's settings, or an agent model for the account.",
      );
    if (entry)
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
          branch: entry?.branch ?? epic.branch,
          targetBranch: epic.targetBranch,
        },
      },
    };
  }

  /**
   * Before the epic's conversation is created: its branch made from its
   * target branch (the project folder's current one when it names none),
   * both written to the epic with the session, and the epic run here. One
   * at a time per project folder.
   */
  prepareSession(session: string, settings: OrchestratorSettings) {
    const root = settings.workspace.root;
    const previous = this.preparing.get(root) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.prepare(session, settings));
    this.preparing.set(root, next);
    const forget = () => {
      if (this.preparing.get(root) === next) this.preparing.delete(root);
    };
    next.then(forget, forget);
    return next;
  }

  private async prepare(session: string, settings: OrchestratorSettings) {
    const connection = this.connection();
    const epics = epicApi(connection);
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
    const kept = (await this.state.get(epic.id))?.branch;
    const targetBranch = epic.targetBranch ?? (await currentBranch(git, root));
    // The branch is the one this host made: a name the API holds that this
    // computer did not keep is refused, never trusted.
    if (epic.branch && epic.branch !== kept)
      throw new Error(
        `The epic names a branch (${epic.branch}) this computer did not make for it.`,
      );
    const branch =
      kept ??
      (await newEpicBranch(git, root, {
        title: epic.title,
        epicId: epic.id,
        taken: (await epics.list(epic.projectId))
          .filter((other) => other.id !== epic.id)
          .flatMap((other) => (other.branch ? [other.branch] : [])),
      }));
    const problem = epicBranchProblem(branch, targetBranch);
    if (problem) throw new Error(problem);
    // Kept here first, then written to the epic, then made: a quit between
    // two steps leaves a name the next call makes, never a branch no epic
    // names nor one this host would not recognise.
    await this.state.register(epic.id, {
      projectId: epic.projectId,
      session,
      apiUrl: connection.url,
      branch,
    });
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
    await this.state.change(epic.id, (entry) => {
      entry.settings = settings;
      entry.stopped = false;
    });
    this.host.stories.retry();
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
   * Answers the engine's approval request for the three tools that start
   * work or merge: allowed at once unless the epic asks before launching;
   * then `create_stories` (unless every story is held), `update_story`
   * when it queues and `approve_story` wait for the person. Any other
   * tool's request is the person's.
   */
  async approval(
    params: HostParamsOf<"host/approval">,
  ): Promise<"approved" | undefined> {
    if (!approvalTools.has(params.tool.name)) return undefined;
    const epicId = await this.state.bySession(params.session);
    if (!epicId) return undefined;
    const epic =
      (await this.epic(epicId, true).catch(() => undefined)) ??
      this.epics.get(epicId);
    // Not read: the person decides.
    if (!epic) return undefined;
    if (!epic.settings.askBeforeLaunch) return "approved";
    const input = (params.input ?? {}) as Record<string, unknown>;
    if (params.tool.name === "create_stories") {
      const stories = Array.isArray(input.stories) ? input.stories : [];
      if (
        stories.length &&
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
   * The story service's gate, from what is kept (never only in memory): a
   * queued story of an epic whose conversation runs elsewhere, that is not
   * read yet, not active, or whose budget is spent does not start.
   */
  holds(story: HostStory): StoryWaitReason | undefined {
    const epicId = story.epicId;
    if (!epicId) return undefined;
    const epic = this.epics.get(epicId);
    if (!epic && this.state.peek(epicId)) this.readLater(epicId);
    return epicHold({
      story,
      ready: this.state.ready(),
      entry: this.state.peek(epicId),
      epic,
    });
  }

  /** A queued story that will not start by itself: held, waiting for the person, or failing to start. */
  blocked(story: HostStory): boolean {
    if (this.holds(story)) return true;
    const wait = this.host.stories
      .queueState()
      .waiting.find((item) => item.storyId === story.id);
    return (
      waitsForPerson(wait?.reason) ||
      (wait?.reason.kind === "error" && this.stuck(story.id))
    );
  }

  /** Signed in: every epic run here is looked at. */
  connected() {
    // What could not be read for another connection may read now.
    this.unread.clear();
    void this.checkAll();
  }

  /** What the screen shows of an epic. */
  async epicState(epicId: string): Promise<EpicState> {
    await this.schedule(epicId);
    return this.publish(await this.reading(epicId));
  }

  /** The window changed the epic (its settings, a pause, a resume): read again, and act on it. */
  async changed(epicId: string): Promise<EpicState> {
    await this.epic(epicId, true);
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
      // The budget may be spent now: the queue's gate reads it.
      this.host.stories.retry();
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
    const connection = this.host.api();
    // Kept for the API it was created through: another one is not asked.
    if (!entry || !connection || !sameApi(entry, connection)) return;
    const epic = await this.epic(epicId, true);
    // Not shown to this connection (another account) or no answer: kept.
    if (!epic) return;
    if (epic.status === "discarded") return this.state.forget(epicId);
    // Until its stories are read, what works is not known.
    if (!this.host.stories.loaded(epic.projectId)) return;
    const client = await this.host.client();
    const conversation = await this.conversations.read(client, entry.session);
    let reading = this.lookAt(epic, entry, conversation);
    if (epic.status === "paused") {
      await pauseEpic(this.pauseHost(), reading, entry, conversation);
      await this.publish(
        this.lookAt(epic, await this.entry(epicId), conversation),
      );
      return;
    }
    if (entry.pause) {
      await resumeEpic(this.pauseHost(), reading);
      reading = this.lookAt(epic, await this.entry(epicId), conversation);
    }
    this.noteFailingStarts(reading.epicStories());
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
    if (conversation.last?.endTurn) this.resumes.delete(epicId);
    // A conversation cut again and again (an engine that keeps stopping)
    // is resumed three times, then left to the person (it shows failed).
    const cut =
      conversation.last?.outcome.status === "interrupted" &&
      !entry.stopped &&
      (this.resumes.get(epicId) ?? 0) < maxResumes;
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
    if (reason === "resumed")
      this.resumes.set(epicId, (this.resumes.get(epicId) ?? 0) + 1);
    const spend = await reading.spend();
    const blocked = this.blockedOf(stories);
    await this.wake(epicId, entry.session, {
      reason,
      stories: unreported,
      board: epicCounts(stories, starting),
      ...(blocked.length ? { blocked } : {}),
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

  private async entry(epicId: string) {
    return (await this.state.get(epicId))!;
  }

  /**
   * The host's message to the conversation, with the settings a window
   * last sent (the epic's model may have changed). Once the engine has it
   * the message is in the records, which say what was told: the kept
   * copies of the turns it carries go.
   */
  private async wake(epicId: string, session: string, wake: OrchestratorWake) {
    const settings = (await this.state.get(epicId))?.settings;
    try {
      await this.host.write({
        session,
        message: { text: "", context: orchestratorWakeText(wake) },
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

  /**
   * The epic, from the API when `fresh` (or not read yet), else as last
   * read. Undefined when the API does not show it (another account, a
   * deleted epic): nothing kept for it is dropped for that.
   */
  async epic(epicId: string, fresh = false): Promise<Epic | undefined> {
    const known = this.epics.get(epicId);
    if (!fresh && known) return known;
    let loading = this.loadingEpics.get(epicId);
    if (!loading) {
      loading = (async () => {
        try {
          const epic = await epicApi(this.connection()).get(epicId);
          this.epics.set(epicId, epic);
          this.unread.delete(epicId);
          return epic;
        } catch (error) {
          this.unread.set(epicId, Date.now());
          if (/404|not found/i.test(String(error))) {
            // What this connection does not show is not this epic's state.
            this.epics.delete(epicId);
            return undefined;
          }
          throw error;
        }
      })().finally(() => this.loadingEpics.delete(epicId));
      this.loadingEpics.set(epicId, loading);
    }
    const epic = await loading;
    if (known?.status !== epic?.status) this.host.stories.retry();
    return epic;
  }

  // The gate's background read of an epic it does not know yet.
  private readLater(epicId: string) {
    if (this.loadingEpics.has(epicId) || !this.host.api()) return;
    if (Date.now() - (this.unread.get(epicId) ?? 0) < epicRetryMs) return;
    void this.epic(epicId, true).catch(() => undefined);
  }

  /** Reads the epic's conversation (when it runs here) for one look. */
  async reading(epicId: string): Promise<EpicReading> {
    const epic = await this.epic(epicId, true);
    if (!epic) throw new Error("This epic cannot be read from the account.");
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
    entry: EpicEntry | undefined,
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

  /** The epic's state, told to the windows when it changed. */
  private async publish(reading: EpicReading): Promise<EpicState> {
    const { epic, entry, conversation } = reading;
    const spend = await reading.spend();
    // What was spent is kept now: the queue's gate holds a spent epic.
    this.host.stories.retry();
    const looked = conversationState(conversation, entry?.stopped === true);
    const { state } = looked;
    const error = looked.error ?? this.wakeErrors.get(epic.id);
    const endTurn = conversation?.last?.endTurn;
    const unreported = entry ? (await reading.unreported()).length : 0;
    const blocked = this.blockedOf(reading.epicStories());
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
      ...(blocked.length ? { blocked } : {}),
      spend,
    };
    const serialized = JSON.stringify(epicState);
    if (this.published.get(epic.id) !== serialized) {
      this.published.set(epic.id, serialized);
      this.host.emit({ type: "epic", epicId: epic.id, state: epicState });
    }
    return epicState;
  }

  /** The epic's queued stories that only the person can start, with why. */
  blockedOf(stories: readonly HostStory[]) {
    return blockedStories(
      stories,
      this.host.stories.queueState().waiting,
      (storyId) => this.stuck(storyId),
    );
  }

  // Each look notes since when each queued story's start keeps failing.
  private noteFailingStarts(stories: readonly HostStory[]) {
    const waits = this.host.stories.queueState().waiting;
    for (const story of stories) {
      const failing = waits.some(
        (wait) => wait.storyId === story.id && wait.reason.kind === "error",
      );
      if (!failing) this.failing.delete(story.id);
      else if (!this.failing.has(story.id))
        this.failing.set(story.id, Date.now());
    }
  }

  private stuck(storyId: string) {
    const since = this.failing.get(storyId);
    return since !== undefined && Date.now() - since >= this.stuckMs;
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

  private pauseHost() {
    return {
      stories: this.host.stories,
      state: this.state,
      interrupt: (session: string) => this.host.interrupt(session),
      report,
    };
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

/** The entry was kept for this API (an entry from before it was noted is this one's). */
function sameApi(entry: EpicEntry, connection: ApiConnection) {
  return !entry.apiUrl || entry.apiUrl === connection.url;
}

function report(error: unknown) {
  console.error(
    "Orchestrator:",
    error instanceof Error ? error.message : String(error),
  );
}
