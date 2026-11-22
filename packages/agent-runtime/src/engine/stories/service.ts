// The story service: the life of every development story of the signed-in
// person's projects on this computer, whatever window shows what
// (docs/engine-in-the-app.md, "Development stories"). It holds the queue
// (stories in `ready`), starts each story that can start (no cap), settles
// each story when a turn of its agent ends, and tells its listeners of each
// ended turn once. It is the one writer of a story's agent fields
// (`agentStatus`, `agentLastError`, `engineSessionId`, `agentModels`) for
// the stories this computer runs; a story another computer of the account
// runs is left alone (`ledger.ts`). A story at work the ledger does not
// name (the previous build left it, or the ledger was lost) is this
// computer's all the same when this computer runs it (`ownership.ts`).
//
// Every path ends in one step, `reconcile`: the story's record read now,
// set against what this computer's engine says of its session. It runs when
// a turn starts or ends, when a project is first read, and every minute,
// so a write that failed, an event that never came or a quit is settled
// there.
//
// Windows call it through `platform.engine` (`story*` methods); the
// engine host's own code calls its methods directly.

import type { TurnOutcome } from "@blame/engine-client";
import type { ApiConnection } from "../../types.js";
import type { EngineModelChoice, EngineSessionStatus } from "../protocol.js";
import type {
  StoryMergeOutcome,
  StoryMessageInput,
  StoryPreferences,
  StoryProject,
  StoryQueueState,
  StoryTurnChoice,
  StoryTurnEnded,
  StoryWaitReason,
  StoryWaiting,
} from "../story-protocol.js";
import { storyApi, type StoryRecord } from "./api.js";
import { approveStory, cleanStory, hasRuntime } from "./endings.js";
import { StoryLedger } from "./ledger.js";
import { StoryOwnership } from "./ownership.js";
import { dependencyWait, queuedStories, retryDelay } from "./queue.js";
import { reconcileDecision } from "./reconcile.js";
import { ReconcileScheduler, withinDeadline } from "./reconciler.js";
import { StoryRecords } from "./records.js";
import { storyTurnModel } from "./settings.js";
import {
  errorMessage,
  startStory,
  type StoryContext,
  type StoryEventExtra,
} from "./start.js";
import {
  definedFields,
  inactiveStoryFields,
  storyLocation,
  storyResumeMessage,
  type HostStory,
  type StoryBriefUpdate,
  type StoryUpdate,
} from "./story.js";
import { pauseStory, sendStoryMessage } from "./turns.js";
import type { StoryServiceHost, StoryServiceOptions } from "./service-host.js";
import { StoryWindows } from "./windows.js";

export type { StoryServiceHost, StoryServiceOptions } from "./service-host.js";

// Stories are read again, and checked against the engine, this often.
const tickMs = 60_000;
// How a write a story must not miss is tried again.
const durableDelays = [1_000, 3_000, 7_000];

export class StoryService {
  private readonly host: StoryServiceHost;
  private readonly ledger: StoryLedger;
  private readonly windows = new StoryWindows();
  private readonly reconciler: ReconcileScheduler;
  private readonly deadlineMs: number;
  /** The API the service reads (its URL): another one starts over. */
  private apiUrl: string | undefined;
  /** Each project's stories, as the API last gave them. */
  private readonly stories = new StoryRecords();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly starting = new Set<string>();
  private readonly waiting = new Map<string, StoryWaiting>();
  private readonly retryAt = new Map<string, number>();
  private readonly writes = new Map<string, Promise<unknown>>();
  /** What is asked of each story, one at a time. */
  private readonly actions = new Map<string, Promise<unknown>>();
  private readonly turnListeners = new Set<(event: StoryTurnEnded) => void>();
  /** The folders kept with the stories this computer runs, by project. */
  private readonly ownedPaths = new Map<string, string>();
  private readonly ownership: StoryOwnership;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private lastQueue = "";

  constructor(host: StoryServiceHost, options: StoryServiceOptions = {}) {
    this.host = host;
    this.ledger = new StoryLedger(options.ledgerFile);
    this.deadlineMs = options.deadlineMs ?? 60_000;
    this.ownership = new StoryOwnership({
      ledger: this.ledger,
      host,
      projectPath: (story) => this.projectPath(story),
      within: (work, what) => this.within(work, what),
      runtimeReady: () => this.windows.preferences()?.runtimePhase === "ready",
    });
    this.reconciler = new ReconcileScheduler(
      (storyId) => this.exclusive(storyId, () => this.reconcile(storyId)),
      options.retryMs,
    );
  }

  /** A window's projects and the person's settings: the queue of those projects runs. */
  async sync(input: {
    window: string;
    projects: StoryProject[];
    preferences: StoryPreferences;
  }) {
    this.windows.sync(input.window, input.projects, input.preferences);
    this.tickTimer ??= setInterval(() => void this.tick(), tickMs);
    this.tickTimer.unref?.();
    // Settings may unblock stories that wait (a model, a runtime now ready).
    this.retryAt.clear();
    await Promise.all(
      input.projects
        .filter((project) => !this.stories.loadedOnce(project.id))
        .map((project) => this.load(project.id)),
    );
    this.pump();
  }

  /** A window closed: its projects stop starting stories, unless another lists them. */
  windowClosed(window: string) {
    this.windows.close(window);
    this.pump();
  }

  /**
   * The API connection the host has now. Signing out, or another API,
   * starts over; a token refreshed for the same API keeps everything.
   */
  connected(connection: ApiConnection | undefined) {
    const url = connection?.url;
    if (this.apiUrl !== undefined && url !== this.apiUrl) {
      this.windows.clear();
      this.stories.clear();
      this.waiting.clear();
      this.retryAt.clear();
    }
    this.apiUrl = url;
    if (url) void this.refresh().catch(report);
  }

  /** Reads one project's stories again (all known without one), then looks at the queue. */
  async refresh(projectId?: string) {
    const known = await this.knownProjects();
    const ids = projectId ? [projectId] : [...known.keys()];
    await Promise.all(
      ids.filter((id) => known.has(id)).map((id) => this.load(id)),
    );
    this.pump();
  }

  /** Looks at a waiting story (every one without an id) again now. */
  retry(storyId?: string | readonly string[]) {
    if (storyId === undefined) this.retryAt.clear();
    for (const id of typeof storyId === "string" ? [storyId] : (storyId ?? []))
      this.retryAt.delete(id);
    this.pump();
  }

  queueState(): StoryQueueState {
    return {
      waiting: [...this.waiting.values()],
      starting: [...this.starting],
      localRunning: this.stories
        .all()
        .filter(
          (story) =>
            story.status === "in-progress" &&
            story.agentStatus === "Running" &&
            story.workspaceMode === "local-container",
        ).length,
    };
  }

  /** Each ended turn of a story's agent, once, after the story is settled. */
  onTurnEnded(listener: (event: StoryTurnEnded) => void) {
    this.turnListeners.add(listener);
    return () => {
      this.turnListeners.delete(listener);
    };
  }

  /** A story the host's own code adds to a project (the orchestrator). */
  async create(input: {
    projectId: string;
    title: string;
    summary: string;
    status?: "backlog" | "ready";
    startsAfter?: string[];
    requestedModel?: HostStory["requestedModel"];
    runMode?: HostStory["runMode"];
    targetBranch?: string | null;
    epicId?: string | null;
    modelIntent?: HostStory["modelIntent"];
  }): Promise<HostStory> {
    const record = await this.api().create({
      ...input,
      status: input.status ?? "backlog",
    });
    this.stories.remember(record, this.stories.now());
    this.emitStory(record);
    this.pump();
    return record.story;
  }

  /** The brief, dependencies or model of a story no agent has started yet (the orchestrator). */
  edit(storyId: string, update: StoryBriefUpdate) {
    return this.exclusive(storyId, async () => {
      const story = await this.read(storyId);
      if (story.status !== "backlog" && story.status !== "ready")
        throw new Error("This story has started: it no longer changes.");
      const edited = await this.patch(story, update);
      this.retry(storyId);
      return edited;
    });
  }

  /** The project's stories were read at least once. */
  loaded(projectId: string) {
    return this.stories.loadedOnce(projectId);
  }

  /** The stories of an epic, as last read. */
  epicStories(epicId: string) {
    return this.stories.all().filter((story) => story.epicId === epicId);
  }

  /** The person's settings the windows gave (the account's agent model…). */
  preferences() {
    return this.windows.preferences();
  }

  /**
   * Where a story's session stands, for a story this computer runs and at
   * work (another computer's is never read: that would pull it here).
   */
  async storyStatus(storyId: string) {
    const story = this.stories.record(storyId)?.story;
    if (!story?.engineSessionId || !hasRuntime(story.status)) return undefined;
    if (!(await this.ledger.owns(storyId))) return undefined;
    return this.within(this.sessionStatus(story), "The agent engine");
  }

  /** Send to Dev Agent: a story of the backlog (or set aside) joins the queue. */
  enqueue(storyId: string) {
    return this.exclusive(storyId, async () => {
      const story = await this.read(storyId);
      if (story.status === "ready") return story;
      if (story.status !== "backlog" && story.status !== "discarded")
        throw new Error("This story's agent is already at work on it.");
      const queued = await this.patch(story, {
        agentLastError: null,
        discardedReason: null,
        status: "ready",
      });
      this.retryAt.delete(storyId);
      this.pump();
      return queued;
    });
  }

  /** A message to the story's agent; a paused or reviewed story works again. */
  send(
    storyId: string,
    input: {
      message: StoryMessageInput;
      steer?: boolean;
      turn?: StoryTurnChoice;
      /** Read in turn with the story's other acts: true leaves it as it is. */
      unless?: (story: HostStory) => boolean;
    },
  ) {
    return this.exclusive(storyId, async () => {
      const read = await this.read(storyId);
      if (input.unless?.(read)) return read;
      const story = await this.claim(read);
      return sendStoryMessage(
        this.context(),
        story,
        this.requiredPath(story),
        input,
      );
    });
  }

  /** Stops the running turn; the story waits, paused, where it was. */
  pause(storyId: string) {
    return this.exclusive(storyId, async () => {
      const story = await this.read(storyId);
      await this.assertHere(story);
      return pauseStory(this.context(), story);
    });
  }

  /**
   * A paused agent picks its conversation back up, once: one already
   * resumed (by the person, or by its epic's resume) is left as it is, as
   * is one `still` no longer wants resumed.
   */
  resume(storyId: string, turn?: StoryTurnChoice, still = () => true) {
    return this.send(storyId, {
      message: { text: storyResumeMessage },
      turn,
      unless: (story) => story.agentStatus === "Running" || !still(),
    });
  }

  /** Undoes a message to the agent and what followed it, files included when they were snapshotted. */
  rewind(storyId: string, to: number, restoreWorkspace: boolean) {
    return this.exclusive(storyId, async () => {
      const story = await this.read(storyId);
      if (!story.engineSessionId)
        throw new Error("This user story has no agent conversation.");
      await this.assertHere(story);
      const rewound = await this.host.call("rewind", {
        session: story.engineSessionId,
        location: storyLocation(story.workspaceMode),
        to,
        restoreWorkspace,
      });
      // The undone turns no longer count for their model.
      this.reconciler.ask(storyId);
      return rewound;
    });
  }

  /**
   * Approve & Merge into the story's target branch; its runtime is cleaned
   * next, and the stories that start after it can start.
   */
  approve(
    storyId: string,
    input: { push?: boolean; model: EngineModelChoice },
  ): Promise<StoryMergeOutcome> {
    return this.exclusive(storyId, async () => {
      const story = await this.read(storyId);
      const repositoryRoot = this.requiredPath(story);
      const outcome = await approveStory(
        this.context(),
        story,
        repositoryRoot,
        input,
      );
      this.cleanNext(story, { removeSession: true });
      this.pump();
      return {
        story: this.payload(storyId),
        merge: outcome.merge,
        repositoryRoot,
        ...(outcome.previewRepairCandidate !== undefined
          ? { previewRepairCandidate: outcome.previewRepairCandidate }
          : {}),
      };
    });
  }

  /** Done without a merge here (a Direct commit, a pull request merged, nothing to merge). */
  complete(
    storyId: string,
    merge: {
      baseCommit?: string | null;
      mergeCommit?: string | null;
      mergedAt?: string | null;
    },
  ) {
    return this.exclusive(storyId, async () => {
      const story = await this.read(storyId);
      if (!hasRuntime(story.status))
        throw new Error("Only a story in progress or in review can be done.");
      const done = await this.patchDurably(story, {
        ...inactiveStoryFields(),
        agentLastError: null,
        status: "done",
        ...definedFields(merge),
      });
      this.cleanNext(story, { removeSession: true });
      this.pump();
      return done;
    });
  }

  /** Discarded: shown so at once; its runtime is cleaned next, before anything else on it. */
  discard(storyId: string, reason: string) {
    return this.exclusive(storyId, async () => {
      const story = await this.read(storyId);
      if (story.status === "done")
        throw new Error("A story that is done cannot be discarded.");
      const discarded = await this.patch(story, {
        discardedReason: reason,
        status: "discarded",
      });
      if (hasRuntime(story.status))
        this.cleanNext(story, {
          removeSession: false,
          after: inactiveStoryFields(),
        });
      else await this.ledger.release(storyId);
      this.pump();
      return discarded;
    });
  }

  /** Back to the backlog; a story at work stops and loses its worktree first. */
  toBacklog(storyId: string) {
    return this.exclusive(storyId, async () => {
      const story = await this.read(storyId);
      if (story.status === "done")
        throw new Error("A story that is done stays done.");
      const working = hasRuntime(story.status);
      if (working) await this.clean(story, { removeSession: false });
      const backlog = await this.patch(story, {
        ...(working ? inactiveStoryFields() : {}),
        discardedReason: null,
        status: "backlog",
      });
      await this.ledger.release(storyId);
      this.pump();
      return backlog;
    });
  }

  /** Deleted for good, with its agent, runtime and worktree. */
  remove(storyId: string) {
    return this.exclusive(storyId, async () => {
      const story = await this.read(storyId);
      await this.clean(story, { removeSession: true }, false);
      await this.api().delete(storyId);
      await this.ledger.release(storyId);
      this.forget(story);
    });
  }

  /** What a window's git flow (Open PR, a Direct commit) said went wrong; null clears it. */
  noteError(storyId: string, error: string | null) {
    return this.exclusive(storyId, async () =>
      this.patch(await this.read(storyId), { agentLastError: error }),
    );
  }

  /** A turn of a session started, or all its turns ended (the engine host's activity). */
  onActivity(event: {
    session: string;
    running: boolean;
    outcome?: TurnOutcome;
  }) {
    const story = this.stories.bySession(event.session);
    if (story) this.reconciler.ask(story.id);
  }

  // ------------------------------------------------------------- reconcile

  /**
   * A story this computer runs, set against what its engine says of the
   * story's session, then the turns it ended told to the listeners. Runs as
   * the story's action, with a deadline on what it waits for.
   */
  private async reconcile(storyId: string) {
    const cached = this.stories.record(storyId)?.story;
    if (
      !(await this.ledger.owns(storyId)) &&
      !(cached && (await this.ownership.adopt(cached)))
    )
      return;
    let story: HostStory;
    try {
      story = await this.within(this.read(storyId), "The account's API");
    } catch (error) {
      // Deleted elsewhere: nothing to settle here any more.
      if (/404|not found/i.test(errorMessage(error))) {
        await this.ledger.release(storyId);
        return;
      }
      throw error;
    }
    const session = story.engineSessionId;
    const status = session
      ? await this.within(this.sessionStatus(story), "The agent engine")
      : undefined;
    const decision = reconcileDecision(story, status);
    let settled = story;
    if (decision.update)
      settled = await this.patchDurably(story, decision.update);
    if (decision.dropSession && session) {
      await this.host
        .call("deleteSession", {
          session,
          location: storyLocation(story.workspaceMode),
        })
        .catch(() => undefined);
      await this.ledger.forget(session);
    } else if (session && status?.exists) {
      // Said at work while no turn runs: its last turn's end was never settled.
      const unsettled =
        story.agentStatus === "Running" &&
        !(status.turnRunning ?? status.running);
      await this.tellEndedTurns(settled, session, status, unsettled);
    }
    // A story no longer at work here is no longer this computer's.
    if (!hasRuntime(settled.status) && settled.agentStatus !== "Running")
      await this.ledger.release(storyId);
    if (decision.update?.status) this.pump();
  }

  private async tellEndedTurns(
    story: HostStory,
    session: string,
    status: EngineSessionStatus,
    unsettled: boolean,
  ) {
    const untold = await this.ledger.untold(
      session,
      status.endedTurns ?? [],
      unsettled,
    );
    for (const ended of untold) {
      await this.ledger.told(session, ended.turn);
      const event: StoryTurnEnded = {
        storyId: story.id,
        projectId: story.projectId,
        session,
        turn: ended.turn,
        story: this.payload(story.id),
        outcome: ended.outcome,
        ...(ended.reply ? { lastReply: ended.reply } : {}),
        spentMicroUsd: status.spentMicroUsd,
        unpricedRequests: status.unpricedRequests,
      };
      for (const listener of this.turnListeners) {
        try {
          listener(event);
        } catch (error) {
          report(error);
        }
      }
    }
  }

  // The engine's answer for the story's session; throws when it gives none.
  private async sessionStatus(story: HostStory) {
    const [status] = await this.host.call("status", {
      sessions: [story.engineSessionId!],
      location: storyLocation(story.workspaceMode),
    });
    if (!status) throw new Error("The agent engine did not answer.");
    return status;
  }

  // What a reconcile waits for, it waits for this long at most: a story's
  // turn is never held by an engine or an API that does not answer.
  private within<T>(work: Promise<T>, what: string): Promise<T> {
    return withinDeadline(work, what, this.deadlineMs);
  }

  /**
   * The stories this computer runs that may not match its engine: all of a
   * project read for the first time (after a quit), else those said Running
   * whose turn does not run, and those In Progress with no agent at work.
   */
  private async reconcileAll(projectId?: string) {
    const owned = await this.ledger.ownedStories();
    const live = new Set(
      projectId
        ? []
        : await this.host.call("running", undefined).catch(() => []),
    );
    for (const [storyId, entry] of owned) {
      if (projectId && entry.projectId !== projectId) continue;
      const story = this.stories.record(storyId)?.story;
      if (!story) continue;
      const session = story.engineSessionId;
      const working =
        story.status === "in-progress" &&
        story.agentStatus === "Running" &&
        session !== undefined &&
        session !== null &&
        live.has(session);
      if (projectId || (!working && !this.starting.has(storyId)))
        this.reconciler.ask(storyId);
    }
  }

  private async tick() {
    await this.refresh().catch(report);
    await this.ownership.adoptAll(this.stories.all()).catch(report);
    await this.reconcileAll().catch(report);
  }

  // ------------------------------------------------------------- ownership

  /**
   * The story, for an action that runs its agent here: one this computer
   * runs already, or one no agent runs now (it is this computer's from now).
   */
  private async claim(story: HostStory) {
    await this.assertHere(story);
    const path = this.requiredPath(story);
    await this.ledger.own(story.id, {
      projectId: story.projectId,
      path,
      ...(story.engineSessionId ? { session: story.engineSessionId } : {}),
    });
    return story;
  }

  private async assertHere(story: HostStory) {
    if (story.agentStatus !== "Running") return;
    if (await this.ownership.adopt(story)) return;
    throw new Error("This story's agent runs on another computer.");
  }

  /** The projects this computer reads: what the windows list, and those of the stories it runs. */
  private async knownProjects() {
    const known = this.windows.projects();
    for (const [, story] of await this.ledger.ownedStories()) {
      this.ownedPaths.set(story.projectId, story.path);
      if (!known.has(story.projectId)) known.set(story.projectId, story.path);
    }
    return known;
  }

  // ----------------------------------------------------------------- queue

  /** Starts every queued story that can start now; says why the others wait. */
  private pump() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const now = Date.now();
    const queued = new Set<string>();
    const preferences = this.windows.preferences();
    const startable = this.windows.projects();
    for (const [projectId, projectStories] of this.stories.projects()) {
      const path = startable.get(projectId);
      for (const story of queuedStories(projectStories)) {
        queued.add(story.id);
        if (this.starting.has(story.id)) continue;
        if ((this.retryAt.get(story.id) ?? 0) > now) continue;
        const held = this.host.holds?.(story);
        if (held) {
          this.setWaiting(story, held, false);
          continue;
        }
        // Reasons seen here cost nothing to check again: no delay for them.
        const reason: StoryWaitReason | undefined = !this.host.api()
          ? { kind: "signed-out" }
          : !path
            ? { kind: "no-project" }
            : (dependencyWait(story, projectStories) ??
              (storyTurnModel(story, preferences, undefined, true)
                ? undefined
                : { kind: "no-model" }));
        if (reason) {
          this.setWaiting(story, reason, false);
          continue;
        }
        this.begin(story, path!);
      }
    }
    for (const id of [...this.waiting.keys()])
      if (!queued.has(id)) this.waiting.delete(id);
    for (const id of [...this.retryAt.keys()])
      if (!queued.has(id)) this.retryAt.delete(id);
    const next = Math.min(...this.retryAt.values());
    if (Number.isFinite(next))
      this.retryTimer = setTimeout(
        () => this.pump(),
        Math.max(0, next - Date.now()),
      );
    this.retryTimer?.unref?.();
    this.emitQueue();
  }

  // A start keeps the reason the story waited for until it has its own
  // answer: the same wait is not announced again at each attempt.
  private begin(story: HostStory, projectPath: string) {
    this.starting.add(story.id);
    void this.exclusive(story.id, () =>
      startStory(this.context(), story, projectPath),
    )
      .then(
        (result) => {
          if ("wait" in result) this.setWaiting(story, result.wait, true);
          else this.waiting.delete(story.id);
          // The cache said ready, the API did not: it learnt the story's
          // status meanwhile; a short pause still keeps the queue from
          // spinning on it.
          if ("notReady" in result)
            this.retryAt.set(story.id, Date.now() + 5_000);
        },
        (error: unknown) =>
          this.setWaiting(
            story,
            { kind: "error", message: errorMessage(error) },
            true,
          ),
      )
      .finally(() => {
        this.starting.delete(story.id);
        this.pump();
      });
    this.emitQueue();
  }

  private setWaiting(
    story: HostStory,
    reason: StoryWaitReason,
    delayed: boolean,
  ) {
    this.waiting.set(story.id, {
      storyId: story.id,
      projectId: story.projectId,
      title: story.title,
      reason,
    });
    if (delayed) this.retryAt.set(story.id, Date.now() + retryDelay(reason));
  }

  private emitQueue() {
    const queue = this.queueState();
    const serialized = JSON.stringify(queue);
    if (serialized === this.lastQueue) return;
    this.lastQueue = serialized;
    this.host.emit({ type: "story-queue", queue });
  }

  // --------------------------------------------------------------- helpers

  /** What a start, a turn or an ending is given. */
  context(): StoryContext {
    const connection = this.host.api();
    if (!connection) throw new Error("Sign in to run user stories.");
    return {
      api: storyApi(connection),
      connection,
      preferences: this.windows.preferences(),
      desktop: this.host.desktop,
      call: (method, input) => this.host.call(method, input),
      read: (storyId) => this.read(storyId),
      patch: (story, update, extra) => this.patch(story, update, extra),
      patchDurably: (story, update) => this.patchDurably(story, update),
      own: (story, path, session) =>
        this.ledger.own(story.id, {
          projectId: story.projectId,
          path,
          ...(session ? { session } : {}),
        }),
      release: (storyId) => this.ledger.release(storyId),
      sessionMade: (session) => this.ledger.begin(session),
      sessionDropped: (session) => this.ledger.forget(session),
    };
  }

  /** The story's payload as the API last sent it, for the windows. */
  payload(storyId: string): unknown {
    return this.stories.record(storyId)?.payload;
  }

  /** The story as the API keeps it now, with its details; the cache learns it. */
  async read(storyId: string): Promise<HostStory> {
    const askedAt = this.stories.now();
    const record = await this.api().get(storyId);
    return (this.stories.remember(record, askedAt) ?? record).story;
  }

  /** The folder of the story's project, which this computer must have. */
  requiredPath(story: HostStory) {
    const path = this.projectPath(story);
    if (!path)
      throw new Error("This story's project is not open on this computer.");
    return path;
  }

  /** A window's folder for the story's project, else one kept with a story run here. */
  private projectPath(story: HostStory) {
    return (
      this.windows.projects().get(story.projectId) ??
      this.ownedPaths.get(story.projectId)
    );
  }

  /** Runs one action on a story at a time: no double resume or merge. */
  exclusive<T>(storyId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.actions.get(storyId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.actions.set(storyId, next);
    const forget = () => {
      if (this.actions.get(storyId) === next) this.actions.delete(storyId);
    };
    next.then(forget, forget);
    return next;
  }

  /**
   * Writes a story, one write at a time per story, and tells the windows.
   * The write's answer counts from when it arrives: a read asked before then
   * never replaces it. It resolves with that answer.
   */
  patch(
    story: HostStory,
    update: StoryUpdate,
    extra: StoryEventExtra = {},
  ): Promise<HostStory> {
    const previous = this.writes.get(story.id) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        const record = await this.api().update(story.id, update);
        const held = this.stories.remember(record, this.stories.now());
        this.emitStory(held ?? record, extra);
        return record.story;
      });
    this.writes.set(story.id, write);
    const forget = () => {
      if (this.writes.get(story.id) === write) this.writes.delete(story.id);
    };
    // The caller handles the write's failure; this only forgets it.
    write.then(forget, forget);
    return write;
  }

  /** A write a story must not miss: tried again before it gives up. */
  async patchDurably(story: HostStory, update: StoryUpdate) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.patch(story, update);
      } catch (error) {
        const wait = durableDelays[attempt];
        if (wait === undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  /**
   * Stops what the story runs and removes its worktree, telling the
   * windows (a Cloud Preview's window state goes too). A story whose agent
   * runs on another computer is not touched here: its agent and worktree
   * are there. One no agent runs that this computer did not start (from
   * before it kept a ledger, or ended there) is cleaned of what this
   * computer has of it.
   */
  private async clean(
    story: HostStory,
    options: { removeSession: boolean },
    release = true,
  ) {
    const running = story.agentStatus === "Running";
    const owned =
      (await this.ledger.story(story.id)) ??
      (running && (await this.ownership.adopt(story))
        ? await this.ledger.story(story.id)
        : undefined);
    const path = owned?.path ?? (running ? undefined : this.projectPath(story));
    const event = {
      projectId: story.projectId,
      storyId: story.id,
      workspaceMode: story.workspaceMode ?? null,
    };
    this.host.emit({ type: "story-cleanup", ...event, cleaning: true });
    try {
      if (path) {
        await cleanStory(this.context(), story, path, options);
        if (options.removeSession && story.engineSessionId)
          await this.ledger.forget(story.engineSessionId);
      }
      if (release) await this.ledger.release(story.id);
      this.host.emit({ type: "story-cleanup", ...event, cleaning: false });
    } catch (error) {
      this.host.emit({
        type: "story-cleanup",
        ...event,
        cleaning: false,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Cleans what the story ran as its next action: anything asked of the
   * story afterwards (a rework, a start on the same worktree's path) waits
   * for it, for as long as the cleanup runs (removing a worktree with its
   * preview's containers can take minutes). What a discard still has to
   * write is written only to the story as the discard left it.
   */
  private cleanNext(
    story: HostStory,
    options: { removeSession: boolean; after?: StoryUpdate },
  ) {
    void this.exclusive(story.id, async () => {
      await this.clean(story, options);
      const after = options.after;
      if (!after) return;
      const now = await this.read(story.id);
      if (now.status === "discarded" && now.worktree === story.worktree)
        await this.patchDurably(now, after);
    }).catch(report);
  }

  /** A story deleted from the account: the service forgets it. */
  forget(story: HostStory) {
    this.stories.delete(story);
    this.waiting.delete(story.id);
    this.retryAt.delete(story.id);
    this.host.emit({
      type: "story-removed",
      projectId: story.projectId,
      storyId: story.id,
    });
    this.pump();
  }

  private emitStory(record: StoryRecord, extra: StoryEventExtra = {}) {
    this.host.emit({
      type: "story",
      projectId: record.story.projectId,
      storyId: record.story.id,
      story: record.payload,
      ...extra,
    });
  }

  private api() {
    const connection = this.host.api();
    if (!connection) throw new Error("Sign in to run user stories.");
    return storyApi(connection);
  }

  private load(projectId: string) {
    const running = this.loading.get(projectId);
    if (running) return running;
    const load = (async () => {
      if (!this.host.api()) return;
      const first = !this.stories.loadedOnce(projectId);
      const askedAt = this.stories.now();
      const records = await this.api().list(projectId);
      const changed = this.stories.replace(projectId, records, askedAt);
      // Stories created or changed elsewhere (another window, another
      // device) show on the boards; the windows read the rest themselves.
      if (!first) for (const record of changed) this.emitStory(record);
      // Where the stories this computer runs were left (a quit, a crash, a
      // turn that ended while Blame was closed) is settled once read.
      if (first) {
        await this.ownership.adoptAll(
          this.stories.projectStories(projectId),
          true,
        );
        await this.reconcileAll(projectId);
      }
    })()
      .catch(report)
      .finally(() => this.loading.delete(projectId));
    this.loading.set(projectId, load);
    return load;
  }

  stop() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.reconciler.stop();
  }
}

function report(error: unknown) {
  console.error("Story service:", errorMessage(error));
}
