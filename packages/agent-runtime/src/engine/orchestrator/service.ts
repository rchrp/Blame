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
  idleSignature,
  idleTold,
  wakeDue,
  waitsForPerson,
  wakeStory,
} from "./board.js";
import { rebuildEntry } from "./adopt.js";
import {
  branchHeld,
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
import {
  FailingStarts,
  blockedStories,
  epicHold,
  stuckStartMs,
} from "./gate.js";
import {
  leaveToPerson,
  pauseEpic,
  resumeEpic,
  type PauseProgress,
} from "./pause.js";
import { epicStateOf } from "./epic-state.js";
import { EpicModels } from "./models.js";
import { EpicReading } from "./reading.js";
import { reviewEpic, type EpicReviewInput } from "./review.js";
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
  /** Since when each queued story's start keeps failing. */
  private readonly failing: FailingStarts;
  /** Why the last look at an epic could not run (the screen is told). */
  private readonly lookErrors = new Map<string, string>();
  /** How far the epic's pause is, as the last look left it. */
  private readonly pauses = new Map<string, PauseProgress>();
  /** The gate's answer for each epic at the last look: a release retries its stories. */
  private readonly holdsSeen = new Map<string, string>();
  /** Epics being found again from the engine's records. */
  private readonly adopting = new Map<string, Promise<boolean>>();
  /** Epic branches being made, by project folder: two at once never pick one name. */
  private readonly preparing = new Map<string, Promise<unknown>>();
  private readonly models: EpicModels;
  private readonly tickTimer: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(host: OrchestratorHost, options: OrchestratorOptions = {}) {
    this.host = host;
    this.failing = new FailingStarts(options.stuckStartMs ?? stuckStartMs);
    this.state = new OrchestratorState(options.stateFile);
    this.models = new EpicModels(host);
    // Attached before the service tells anything (it tells after a sync).
    host.stories.onTurnEnded((event) => void this.turnEnded(event));
    this.tickTimer = setInterval(
      () => void this.checkAll(),
      options.tickMs ?? 60_000,
    );
    this.tickTimer.unref?.();
    // Until the file is read every epic story is held: the gate answers
    // from it from then on.
    void this.state.all().then(() => this.retryHeld(), report);
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
    if (epic.engineSessionId === session) await this.adopt(epic.id);
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
    this.retryEpic(epic.id);
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
    // Not kept here: its conversation may still be this computer's.
    if (this.state.ready() && !this.state.peek(epicId)) this.adoptLater(epicId);
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
      (wait?.reason.kind === "error" && this.failing.stuck(story.id))
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
    await this.adopt(epicId).catch(report);
    await this.schedule(epicId);
    return this.publish(await this.reading(epicId));
  }

  /**
   * The window changed the epic (its settings, a pause, a resume): read
   * again, and act on it now. What it answers says whether a pause took
   * (`pause`); one that could not even look fails with why.
   */
  async changed(epicId: string): Promise<EpicState> {
    try {
      await this.epic(epicId, true);
      return await this.epicState(epicId);
    } catch (error) {
      throw new Error(
        `Blame could not act on the epic's change: ${errorText(error)}`,
        { cause: error },
      );
    }
  }

  /** The person merges a finished epic, or opens its pull request. */
  review = (input: EpicReviewInput) => reviewEpic(this, this.host, input);

  /**
   * A person acted on a story from a window (a message, a pause, a resume,
   * a discard…): it is theirs from then on, through the epic's pause.
   */
  touched(storyId: string) {
    return leaveToPerson(this.state, storyId).catch(report);
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
      // Not kept here: its conversation may still be this computer's.
      if (!epicId || !(await this.adopt(epicId))) return;
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
      // The budget may be spent now: the gate reads it at the next start.
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
          await this.check(epicId).catch((error: unknown) => {
            this.lookErrors.set(epicId, errorText(error));
            report(error);
          });
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
    const cannot = (why: string) => {
      this.lookErrors.set(epicId, why);
    };
    if (!entry)
      return cannot("The epic's conversation does not run on this computer.");
    if (!connection) return cannot("Blame is signed out.");
    // Kept for the API it was created through: another one is not asked.
    if (!sameApi(entry, connection))
      return cannot("The epic belongs to another account or deployment.");
    const epic = await this.epic(epicId, true);
    // Not shown to this connection (another account) or no answer: kept.
    if (!epic) return cannot("The account does not show this epic.");
    if (epic.status === "discarded") return this.state.forget(epicId);
    // Until its stories are read, what works is not known.
    if (!this.host.stories.loaded(epic.projectId))
      return cannot("The epic's project is not read on this computer yet.");
    const client = await this.host.client();
    const conversation = await this.conversations.read(client, entry.session);
    this.lookErrors.delete(epicId);
    let reading = this.lookAt(epic, entry, conversation);
    await reading.prune();
    await this.checkBranch(
      epic,
      await this.entry(epicId),
      reading.epicStories(),
    );
    if (epic.status === "paused") {
      this.pauses.set(
        epicId,
        await pauseEpic(
          this.pauseHost(),
          reading,
          await this.entry(epicId),
          conversation,
        ),
      );
      await this.publish(
        this.lookAt(epic, await this.entry(epicId), conversation),
      );
      // The person may talk to it while paused: their message that waited
      // through a quit goes on. The queue goes on from its first message,
      // so a wake that waited too is taken back first: nothing wakes it
      // while paused, and what it carried is told after the resume, once.
      // A queue of wakes only waits for the resume.
      const person = conversation.queued.find(
        (turn) => !conversation.wakes.has(turn),
      );
      if (conversation.exists && !conversation.running && person) {
        for (const turn of conversation.queued)
          if (conversation.wakes.has(turn))
            await this.host.call("withdraw", { session: entry.session, turn });
        await this.host.call("promote", {
          session: entry.session,
          turn: person,
        });
      }
      return;
    }
    this.pauses.delete(epicId);
    // A resume the pause's cut turn goes on with does not count as a cut.
    let pauseCut = false;
    if (entry.pause) {
      const cutTurn = entry.pause.cut;
      const resumed = await resumeEpic(this.pauseHost(), reading);
      if (!resumed.done) {
        await this.publish(
          this.lookAt(epic, await this.entry(epicId), conversation),
        );
        return;
      }
      // The cut turn is owed its `resumed` wake only while it is still the
      // conversation's last, nothing came after it and the person did not
      // stop it; otherwise the pause ends here.
      const last = conversation.last;
      pauseCut =
        resumed.turn &&
        epic.status === "active" &&
        !conversation.running &&
        !conversation.queued.length &&
        last?.outcome.status === "interrupted" &&
        !entry.stopped &&
        (cutTurn === undefined || last.turn === cutTurn);
      if (!pauseCut)
        await this.state.change(epicId, (item) => delete item.pause);
    }
    reading = this.lookAt(epic, await this.entry(epicId), conversation);
    this.failing.note(
      reading.epicStories(),
      this.host.stories.queueState().waiting,
    );
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
    if (["idle", "replied", "asking", "stopped"].includes(state)) return;
    const unreported = await reading.unreported();
    const stories = reading.epicStories();
    const starting = this.starting(stories);
    if (conversation.last?.endTurn) this.resumes.delete(epicId);
    const interrupted =
      conversation.last?.outcome.status === "interrupted" && !entry.stopped;
    // A conversation cut again and again (an engine that keeps stopping)
    // is resumed three times, then left to the person (it shows failed).
    const cut =
      interrupted && (pauseCut || (this.resumes.get(epicId) ?? 0) < maxResumes);
    const blocked = this.blockedOf(stories);
    // Told once for each `wait` it ended with: the same wait, with nothing
    // about the epic's stories changed since (none started, the person did
    // nothing, no other error), is not news. A wait accepted after it (so
    // something worked then) is answered again once nothing does.
    const told = idleTold(
      conversation.last?.turn,
      idleSignature(stories, blocked),
    );
    const reason: OrchestratorWake["reason"] | undefined = cut
      ? "resumed"
      : wakeDue(stories, starting, unreported)
        ? "stories"
        : state === "waiting" &&
            !unreported.length &&
            told !== (await this.entry(epicId)).idleTold &&
            !epicHasWork(stories, starting, (story) =>
              this.blocked(story as HostStory),
            )
          ? "idle"
          : undefined;
    if (!reason) return;
    if (reason === "resumed" && !pauseCut)
      this.resumes.set(epicId, (this.resumes.get(epicId) ?? 0) + 1);
    const spend = await reading.spend();
    await this.wake(epicId, entry.session, {
      reason,
      ...(reason === "resumed" ? { cut: pauseCut ? "pause" : "quit" } : {}),
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
    await this.state.change(epicId, (item) => {
      if (reason === "idle") item.idleTold = told;
      if (pauseCut) delete item.pause;
    });
  }

  // The epic's branch is still there, or made again, or the epic holds.
  private async checkBranch(
    epic: Epic,
    entry: EpicEntry,
    stories: readonly HostStory[],
  ) {
    const git = this.host.git;
    const root = entry.settings?.workspace.root;
    if (!git || !root || !entry.branch || !epic.targetBranch) return;
    const held = await branchHeld(git, root, {
      branch: entry.branch,
      targetBranch: epic.targetBranch,
      merged: stories.some((story) => story.status === "done"),
    });
    if ((entry.branchGone ?? false) === held) return;
    await this.state.change(epic.id, (item) => {
      if (held) item.branchGone = true;
      else delete item.branchGone;
    });
    if (!held) this.retryEpic(epic.id);
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
    if (known?.status !== epic?.status) this.releaseHeld(epicId);
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
    // What was spent is kept now: a gate the look released lets its
    // stories go (only the epic's: others keep their own pace).
    this.releaseHeld(epic.id);
    const epicState = epicStateOf({
      epic,
      entry,
      conversation,
      spend,
      unreported: entry ? (await reading.unreported()).length : 0,
      blocked: this.blockedOf(reading.epicStories()),
      errors: {
        file: this.state.failure(),
        look: this.lookErrors.get(epic.id),
        wake: this.wakeErrors.get(epic.id),
      },
      pause: this.pauses.get(epic.id),
    });
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
      (storyId) => this.failing.stuck(storyId),
    );
  }

  /** Lets the epic's queued stories be looked at again now (none of any other). */
  private retryEpic(epicId: string) {
    const ids = this.host.stories
      .epicStories(epicId)
      .filter((story) => story.status === "ready")
      .map((story) => story.id);
    if (ids.length) this.host.stories.retry(ids);
  }

  // Once the gate's answer for an epic changed, its stories are looked at again.
  private releaseHeld(epicId: string) {
    const hold = JSON.stringify(this.holds({ epicId } as HostStory) ?? null);
    if (this.holdsSeen.get(epicId) === hold) return;
    this.holdsSeen.set(epicId, hold);
    this.retryEpic(epicId);
  }

  // The stories the gate held while the file was not read yet.
  private retryHeld() {
    const ids = this.host.stories
      .queueState()
      .waiting.filter((wait) => wait.reason.kind === "epic")
      .map((wait) => wait.storyId);
    if (ids.length) this.host.stories.retry(ids);
  }

  /**
   * An epic the kept file does not know (it was lost, or set aside) whose
   * conversation this computer's engine has is run here: its entry is
   * built again from the API and the conversation's records, which name
   * the branch this host made (its prompt) and the folder it reads.
   */
  async adopt(epicId: string): Promise<boolean> {
    const known = this.adopting.get(epicId);
    if (known) return known;
    const adopting = this.rebuild(epicId).finally(() =>
      this.adopting.delete(epicId),
    );
    this.adopting.set(epicId, adopting);
    return adopting;
  }

  private async rebuild(epicId: string): Promise<boolean> {
    if (await this.state.get(epicId)) return true;
    const connection = this.host.api();
    if (!connection) return false;
    const epic = await this.epic(epicId, true);
    if (!epic) return false;
    const adopted = await rebuildEntry({
      epic,
      apiUrl: connection.url,
      client: await this.host.client(),
      conversations: this.conversations,
      state: this.state,
      stories: this.host.stories.epicStories(epicId),
      status: (storyId) =>
        this.host.stories.storyStatus(storyId).catch(() => undefined),
    });
    if (adopted) this.retryEpic(epicId);
    return adopted;
  }

  // The gate's background search of an epic the file does not know.
  private adoptLater(epicId: string) {
    if (this.adopting.has(epicId) || !this.host.api()) return;
    if (Date.now() - (this.unread.get(`adopt\n${epicId}`) ?? 0) < epicRetryMs)
      return;
    this.unread.set(`adopt\n${epicId}`, Date.now());
    void this.adopt(epicId).catch(() => undefined);
  }

  /**
   * The epic's stories being started that will run. A blocked story's
   * attempt (its wait needs the person, or its start keeps failing) keeps
   * its wait and ends with it: it is not work, and nothing it does wakes.
   */
  private starting(stories: readonly HostStory[]) {
    const blocked = new Set(
      stories
        .filter((story) => story.status === "ready" && this.blocked(story))
        .map((story) => story.id),
    );
    return new Set(
      this.host.stories.queueState().starting.filter((id) => !blocked.has(id)),
    );
  }

  /** The epic's model, else the one a window sent, else the account's agent model. */
  orchestratorModel(epic: Epic, sent?: EngineModelChoice) {
    return this.models.orchestrator(epic, sent);
  }

  fallbackModel() {
    return this.models.fallback();
  }

  /** The ranking the stories' models are chosen from (the providers list's). */
  modelRanking() {
    return this.models.ranking();
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
      starting: (stories) => this.starting(stories),
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

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
