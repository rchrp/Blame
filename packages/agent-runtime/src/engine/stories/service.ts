// The story service: the life of every development story of the signed-in
// person's projects on this computer, whatever window shows what
// (docs/engine-in-the-app.md, "Development stories"). It holds the queue
// (stories in `ready`), starts each story that can start (no cap), settles
// each story when a turn of its agent ends, and tells its listeners of each
// ended turn once. It is the one writer of a story's agent fields
// (`agentStatus`, `agentLastError`, `engineSessionId`, `agentModels`).
//
// Every path ends in one step, `reconcile`: the story's record read now,
// set against what the engine says of its session. It runs when a turn
// starts or ends, when a project is first read, and every minute, so a
// write that failed, an event that never came or a quit is settled there.
//
// Windows call it through `platform.engine` (`story*` methods); the
// engine host's own code calls its methods directly.

import type { TurnOutcome } from "@blame/engine-client";
import type { ApiConnection } from "../../types.js";
import type { DesktopServices } from "../desktop-services.js";
import type {
  EngineHostInput,
  EngineHostMethod,
  EngineHostResult,
  EngineModelChoice,
  EngineSessionStatus,
} from "../protocol.js";
import type {
  StoryHostEvent,
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
import { TurnLedger } from "./ledger.js";
import { dependencyWait, queuedStories, retryDelay } from "./queue.js";
import { reconcileDecision } from "./reconcile.js";
import { StoryRecords } from "./records.js";
import { storyTurnModel } from "./settings.js";
import {
  errorMessage,
  startStory,
  type StoryContext,
  type StoryEventExtra,
} from "./start.js";
import {
  inactiveStoryFields,
  storyLocation,
  storyResumeMessage,
  type HostStory,
  type StoryUpdate,
} from "./story.js";
import { pauseStory, sendStoryMessage } from "./turns.js";

export type StoryServiceHost = {
  api(): ApiConnection | undefined;
  /** The engine host's own calls (createSession, send, status…). */
  call<M extends EngineHostMethod>(
    method: M,
    input: EngineHostInput<M>,
  ): Promise<EngineHostResult<M>>;
  desktop: DesktopServices;
  emit(event: StoryHostEvent): void;
};

// Stories are read again, and checked against the engine, this often.
const tickMs = 60_000;
// A reconcile that could not finish (the API or the engine did not answer).
const reconcileRetryMs = 15_000;
// What a window says it prepares counts this long without news.
const initializingMs = 15 * 60_000;
// How a write a story must not miss is tried again.
const durableDelays = [1_000, 3_000, 7_000];

type WindowSync = {
  projects: StoryProject[];
  preferences: StoryPreferences;
  at: number;
};

export class StoryService {
  private readonly host: StoryServiceHost;
  private readonly ledger: TurnLedger;
  /** What each window said last: the projects are what they know together. */
  private readonly windows = new Map<string, WindowSync>();
  private readonly projects = new Map<string, string>();
  private latest: StoryPreferences | undefined;
  private account: string | undefined;
  /** Each project's stories, as the API last gave them. */
  private readonly stories = new StoryRecords();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly starting = new Set<string>();
  private readonly waiting = new Map<string, StoryWaiting>();
  private readonly retryAt = new Map<string, number>();
  /** Stories whose reconcile is asked and not begun yet. */
  private readonly toReconcile = new Set<string>();
  private readonly writes = new Map<string, Promise<unknown>>();
  /** What is asked of each story, one at a time. */
  private readonly actions = new Map<string, Promise<unknown>>();
  private readonly turnListeners = new Set<(event: StoryTurnEnded) => void>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private lastQueue = "";

  constructor(host: StoryServiceHost, options: { ledgerFile?: string } = {}) {
    this.host = host;
    this.ledger = new TurnLedger(options.ledgerFile);
  }

  /**
   * A window's projects and the person's settings. Projects are added, never
   * dropped while the same account is signed in: a story of a project only
   * another window (or no window now) knows keeps running and settling.
   */
  async sync(input: {
    window: string;
    projects: StoryProject[];
    preferences: StoryPreferences;
  }) {
    this.windows.set(input.window, {
      projects: input.projects,
      preferences: input.preferences,
      at: Date.now(),
    });
    this.latest = input.preferences;
    const added = input.projects.filter(
      (project) => this.projects.get(project.id) !== project.path,
    );
    for (const project of input.projects)
      this.projects.set(project.id, project.path);
    this.tickTimer ??= setInterval(() => void this.tick(), tickMs);
    this.tickTimer.unref?.();
    // Settings may unblock stories that wait (a model, a runtime now ready).
    this.retryAt.clear();
    await Promise.all(added.map((project) => this.load(project.id)));
    this.pump();
  }

  /**
   * The API connection the host has now: another account (or none) starts
   * over, with no project and no story.
   */
  connected(connection: ApiConnection | undefined) {
    const account = connection
      ? `${connection.url}\u0000${connection.token ?? ""}`
      : undefined;
    if (account === this.account) return;
    const switched = this.account !== undefined;
    this.account = account;
    if (switched) {
      this.windows.clear();
      this.projects.clear();
      this.stories.clear();
      this.waiting.clear();
      this.retryAt.clear();
    }
    if (account) void this.refresh().catch(report);
  }

  /** Reads one project's stories again (all projects without one), then looks at the queue. */
  async refresh(projectId?: string) {
    const ids = projectId ? [projectId] : [...this.projects.keys()];
    await Promise.all(
      ids.filter((id) => this.projects.has(id)).map((id) => this.load(id)),
    );
    this.pump();
  }

  /** Looks at a waiting story (every one without an id) again now. */
  retry(storyId?: string) {
    if (storyId) this.retryAt.delete(storyId);
    else this.retryAt.clear();
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
  }): Promise<HostStory> {
    const askedAt = this.stories.now();
    const record = await this.api().create({
      ...input,
      status: input.status ?? "backlog",
    });
    this.stories.remember(record, askedAt);
    this.emitStory(record);
    this.pump();
    return record.story;
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
    },
  ) {
    return this.exclusive(storyId, async () => {
      const story = await this.read(storyId);
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
    return this.exclusive(storyId, async () =>
      pauseStory(this.context(), await this.read(storyId)),
    );
  }

  /** A paused agent picks its conversation back up. */
  resume(storyId: string, turn?: StoryTurnChoice) {
    return this.send(storyId, { message: { text: storyResumeMessage }, turn });
  }

  /** Undoes a message to the agent and what followed it, files included when they were snapshotted. */
  rewind(storyId: string, to: number, restoreWorkspace: boolean) {
    return this.exclusive(storyId, async () => {
      const story = await this.read(storyId);
      if (!story.engineSessionId)
        throw new Error("This user story has no agent conversation.");
      const rewound = await this.host.call("rewind", {
        session: story.engineSessionId,
        location: storyLocation(story.workspaceMode),
        to,
        restoreWorkspace,
      });
      // The undone turns no longer count for their model.
      this.reconcileSoon(storyId);
      return rewound;
    });
  }

  /**
   * Approve & Merge into the story's target branch; its runtime is cleaned
   * meanwhile, and the stories that start after it can start.
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
      this.cleanInBackground(story, { removeSession: true });
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
      this.cleanInBackground(story, { removeSession: true });
      this.pump();
      return done;
    });
  }

  /** Discarded: shown so at once, its runtime cleaned meanwhile. */
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
        this.cleanInBackground(story, {
          removeSession: false,
          after: inactiveStoryFields(),
        });
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
      if (working)
        await cleanStory(
          this.context(),
          story,
          this.projectPath(story.projectId),
          { removeSession: false },
        );
      const backlog = await this.patch(story, {
        ...(working ? inactiveStoryFields() : {}),
        discardedReason: null,
        status: "backlog",
      });
      this.pump();
      return backlog;
    });
  }

  /** Deleted for good, with its agent, runtime and worktree. */
  remove(storyId: string) {
    return this.exclusive(storyId, async () => {
      const story = await this.read(storyId);
      await cleanStory(
        this.context(),
        story,
        this.projectPath(story.projectId),
        { removeSession: true },
      );
      await this.api().delete(storyId);
      if (story.engineSessionId)
        await this.ledger.forget(story.engineSessionId).catch(report);
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
    if (story) this.reconcileSoon(story.id);
  }

  // ------------------------------------------------------------- reconcile

  /** Reconciles the story after whatever is asked of it now. */
  private reconcileSoon(storyId: string) {
    if (this.toReconcile.has(storyId)) return;
    this.toReconcile.add(storyId);
    void this.exclusive(storyId, () => {
      this.toReconcile.delete(storyId);
      return this.reconcile(storyId);
    }).catch((error: unknown) => {
      report(error);
      // The API or the engine did not answer: the story is looked at again.
      setTimeout(() => this.reconcileSoon(storyId), reconcileRetryMs).unref?.();
    });
  }

  /**
   * The story's record set against what the engine says of its session,
   * then the turns it ended told to the listeners. Runs as the story's
   * action: nothing else is asked of the story meanwhile.
   */
  private async reconcile(storyId: string) {
    const story = await this.read(storyId).catch((error: unknown) => {
      // Deleted elsewhere: nothing to settle.
      if (/404|not found/i.test(errorMessage(error))) return undefined;
      throw error;
    });
    if (!story) return;
    const session = story.engineSessionId;
    const status = session ? await this.sessionStatus(story) : undefined;
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
      await this.tellEndedTurns(settled, session, status);
    }
    if (decision.update?.status) this.pump();
  }

  private async tellEndedTurns(
    story: HostStory,
    session: string,
    status: EngineSessionStatus,
  ) {
    const untold = await this.ledger.untold(session, status.endedTurns ?? []);
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

  /**
   * Every story whose record may not match the engine is reconciled: all
   * those with a session or at work in a project read for the first time,
   * else those said Running whose turn does not run, and those In Progress
   * with no agent at work.
   */
  private async reconcileAll(projectId?: string) {
    const stories = projectId
      ? this.stories.projectStories(projectId)
      : this.stories.all();
    const live = new Set(
      projectId
        ? []
        : await this.host.call("running", undefined).catch(() => []),
    );
    for (const story of stories) {
      const active = hasRuntime(story.status);
      const session = story.engineSessionId;
      const look = projectId
        ? active || story.agentStatus === "Running"
        : (story.agentStatus === "Running" &&
            !(session && live.has(session))) ||
          (story.status === "in-progress" &&
            story.agentStatus !== "Paused" &&
            !this.starting.has(story.id) &&
            !(session && live.has(session)));
      if (look) this.reconcileSoon(story.id);
    }
  }

  private async tick() {
    await this.refresh().catch(report);
    await this.reconcileAll().catch(report);
  }

  // ----------------------------------------------------------------- queue

  /** Starts every queued story that can start now; says why the others wait. */
  private pump() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const now = Date.now();
    const queued = new Set<string>();
    const preferences = this.preferences();
    for (const [projectId, projectStories] of this.stories.projects()) {
      const path = this.projects.get(projectId);
      for (const story of queuedStories(projectStories)) {
        queued.add(story.id);
        if (this.starting.has(story.id)) continue;
        if ((this.retryAt.get(story.id) ?? 0) > now) continue;
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

  private begin(story: HostStory, projectPath: string) {
    this.starting.add(story.id);
    this.waiting.delete(story.id);
    void this.exclusive(story.id, () =>
      startStory(this.context(), story, projectPath),
    )
      .then(
        (result) => {
          if ("wait" in result) this.setWaiting(story, result.wait, true);
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

  /**
   * The person's settings as the windows said them: the latest, with the
   * projects any window prepares now and every context cap picked.
   */
  private preferences(): StoryPreferences | undefined {
    if (!this.latest) return undefined;
    const fresh = [...this.windows.values()].filter(
      (sync) => Date.now() - sync.at < initializingMs,
    );
    return {
      ...this.latest,
      initializingProjects: [
        ...new Set(
          fresh.flatMap((sync) => sync.preferences.initializingProjects ?? []),
        ),
      ],
      contextLimits: Object.assign(
        {},
        ...[...this.windows.values()].map(
          (sync) => sync.preferences.contextLimits ?? {},
        ),
        this.latest.contextLimits ?? {},
      ),
    };
  }

  // --------------------------------------------------------------- helpers

  /** What a start, a turn or an ending is given. */
  context(): StoryContext {
    const connection = this.host.api();
    if (!connection) throw new Error("Sign in to run user stories.");
    return {
      api: storyApi(connection),
      connection,
      preferences: this.preferences(),
      desktop: this.host.desktop,
      call: (method, input) => this.host.call(method, input),
      read: (storyId) => this.read(storyId),
      patch: (story, update, extra) => this.patch(story, update, extra),
      patchDurably: (story, update) => this.patchDurably(story, update),
      sessionMade: (session) => this.ledger.begin(session),
    };
  }

  /** The story's payload as the API last sent it, for the windows. */
  payload(storyId: string): unknown {
    return this.stories.record(storyId)?.payload;
  }

  /** The project folder of a story's project, when this computer has it. */
  projectPath(projectId: string) {
    return this.projects.get(projectId);
  }

  /** The story as the API keeps it now, with its details; the cache learns it. */
  async read(storyId: string): Promise<HostStory> {
    const askedAt = this.stories.now();
    const record = await this.api().get(storyId);
    return (this.stories.remember(record, askedAt) ?? record).story;
  }

  /** The folder of the story's project, which this computer must have. */
  requiredPath(story: HostStory) {
    const path = this.projects.get(story.projectId);
    if (!path)
      throw new Error("This story's project is not open on this computer.");
    return path;
  }

  /** Runs one action on a story at a time: no double resume or merge. */
  exclusive<T>(storyId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.actions.get(storyId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.actions.set(storyId, next);
    void next.then(
      () => this.forgetAction(storyId, next),
      () => this.forgetAction(storyId, next),
    );
    return next;
  }

  private forgetAction(storyId: string, action: Promise<unknown>) {
    if (this.actions.get(storyId) === action) this.actions.delete(storyId);
  }

  /** Writes a story, one write at a time per story, and tells the windows. */
  patch(
    story: HostStory,
    update: StoryUpdate,
    extra: StoryEventExtra = {},
  ): Promise<HostStory> {
    const previous = this.writes.get(story.id) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        const askedAt = this.stories.now();
        const record = await this.api().update(story.id, update);
        const held = this.stories.remember(record, askedAt) ?? record;
        this.emitStory(held, extra);
        return held.story;
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
   * Cleans what the story ran, outside its turn. What a discard still has
   * to write is written as the story's action, and only to the story as the
   * discard left it: a story reworked and started again meanwhile keeps its
   * new worktree.
   */
  private cleanInBackground(
    story: HostStory,
    options: { removeSession: boolean; after?: StoryUpdate },
  ) {
    const event = {
      projectId: story.projectId,
      storyId: story.id,
      workspaceMode: story.workspaceMode ?? null,
    };
    this.host.emit({ type: "story-cleanup", ...event, cleaning: true });
    void cleanStory(
      this.context(),
      story,
      this.projectPath(story.projectId),
      options,
    )
      .then(async () => {
        if (options.removeSession && story.engineSessionId)
          await this.ledger.forget(story.engineSessionId);
        const after = options.after;
        if (!after) return;
        await this.exclusive(story.id, async () => {
          const now = await this.read(story.id);
          if (now.status === "discarded" && now.worktree === story.worktree)
            await this.patchDurably(now, after);
        });
      })
      .then(
        () =>
          this.host.emit({ type: "story-cleanup", ...event, cleaning: false }),
        (error: unknown) => {
          report(error);
          this.host.emit({
            type: "story-cleanup",
            ...event,
            cleaning: false,
            error: errorMessage(error),
          });
        },
      );
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
      if (!this.projects.has(projectId)) return;
      this.stories.replace(projectId, records, askedAt);
      // Where this project's stories were left (a quit, a crash, a turn
      // that ended while Blame was closed) is settled once it is read.
      if (first) await this.reconcileAll(projectId);
    })()
      .catch(report)
      .finally(() => this.loading.delete(projectId));
    this.loading.set(projectId, load);
    return load;
  }

  stop() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
  }
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Partial<T>;
}

function report(error: unknown) {
  console.error("Story service:", errorMessage(error));
}
