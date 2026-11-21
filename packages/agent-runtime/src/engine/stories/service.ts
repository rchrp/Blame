// The story service: the life of every development story of the signed-in
// person's projects on this computer, whatever window shows what
// (docs/engine-in-the-app.md, "Development stories"). It holds the queue
// (stories in `ready`), starts each story that can start (no cap), settles
// each story when a turn of its agent ends, and finds where stories were
// left after a quit. It is the one writer of a story's agent fields
// (`agentStatus`, `agentLastError`, `engineSessionId`, `agentModels`).
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
  EngineLocation,
} from "../protocol.js";
import type {
  StoryHostEvent,
  StoryPreferences,
  StoryQueueState,
  StoryTurnEnded,
  StoryWaitReason,
  StoryWaiting,
} from "../story-protocol.js";
import { storyApi, type StoryRecord } from "./api.js";
import { dependencyWait, queuedStories, retryDelay } from "./queue.js";
import {
  errorMessage,
  startStory,
  type StoryContext,
  type StoryEventExtra,
} from "./start.js";
import {
  storyLocation,
  storyOutcomeUpdate,
  withTurnCounts,
  type HostStory,
  type StoryUpdate,
} from "./story.js";

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

// Stories changed elsewhere (another device, the API) are read again this often.
const reloadIntervalMs = 60_000;

export class StoryService {
  private readonly host: StoryServiceHost;
  private readonly projects = new Map<string, string>();
  private preferences: StoryPreferences | undefined;
  /** Each project's stories, as the API last gave them. */
  private readonly stories = new Map<string, Map<string, StoryRecord>>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly starting = new Set<string>();
  private readonly waiting = new Map<string, StoryWaiting>();
  private readonly retryAt = new Map<string, number>();
  /** Sessions already settled after a quit. */
  private readonly recovered = new Set<string>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly turnListeners = new Set<(event: StoryTurnEnded) => void>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private reloadTimer: ReturnType<typeof setInterval> | undefined;
  private lastQueue = "";

  constructor(host: StoryServiceHost) {
    this.host = host;
  }

  /** The projects on this computer and the person's settings; loads new projects. */
  async sync(input: {
    projects: { id: string; path: string }[];
    preferences: StoryPreferences;
  }) {
    this.preferences = input.preferences;
    const known = new Set(input.projects.map((project) => project.id));
    for (const id of [...this.projects.keys()])
      if (!known.has(id)) {
        this.projects.delete(id);
        this.stories.delete(id);
      }
    const added = input.projects.filter(
      (project) => this.projects.get(project.id) !== project.path,
    );
    for (const project of input.projects)
      this.projects.set(project.id, project.path);
    this.reloadTimer ??= setInterval(
      () => void this.refresh().catch(() => undefined),
      reloadIntervalMs,
    );
    this.reloadTimer.unref?.();
    // Settings may unblock stories that wait (a model, a runtime now ready).
    this.retryAt.clear();
    await Promise.all(added.map((project) => this.load(project.id)));
    this.pump();
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
      localRunning: this.allStories().filter(
        (story) =>
          story.status === "in-progress" &&
          story.agentStatus === "Running" &&
          story.workspaceMode === "local-container",
      ).length,
    };
  }

  /** Every ended turn of a story's agent, once the story is settled. */
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
    const record = await this.api().create({
      ...input,
      status: input.status ?? "backlog",
    });
    this.remember(record);
    this.emitStory(record);
    this.pump();
    return record.story;
  }

  /** Send to Dev Agent: the story joins the queue. */
  async enqueue(storyId: string) {
    const story = await this.current(storyId);
    const queued = await this.patch(story, {
      agentLastError: null,
      status: "ready",
    });
    this.retryAt.delete(storyId);
    this.pump();
    return queued;
  }

  /** Undoes a message to the agent and what followed it, files included when they were snapshotted. */
  async rewind(storyId: string, to: number, restoreWorkspace: boolean) {
    const story = await this.current(storyId);
    if (!story.engineSessionId)
      throw new Error("This user story has no agent conversation.");
    const rewound = await this.host.call("rewind", {
      session: story.engineSessionId,
      location: storyLocation(story.workspaceMode),
      to,
      restoreWorkspace,
    });
    // The undone turns no longer count for their model.
    void this.countTurns(story).catch(report);
    return rewound;
  }

  private async countTurns(story: HostStory) {
    const status = await this.sessionStatus(story);
    const agentModels = status
      ? withTurnCounts(story.agentModels, status.models)
      : undefined;
    if (agentModels) await this.patch(story, { agentModels });
  }

  /** A turn of a session started, or all its turns ended (the engine host's activity). */
  onActivity(event: {
    session: string;
    running: boolean;
    outcome?: TurnOutcome;
  }) {
    const story = this.allStories().find(
      (item) => item.engineSessionId === event.session,
    );
    if (!story) return;
    if (event.running) {
      if (story.agentStatus !== "Running" && story.status === "in-progress")
        void this.patch(story, { agentStatus: "Running" }).catch(report);
      return;
    }
    void this.settleTurn(story, event.outcome).catch(report);
  }

  /** What the end of a turn means for the story, then who listens. */
  private async settleTurn(story: HostStory, outcome: TurnOutcome | undefined) {
    const status = await this.sessionStatus(story);
    // How many turns each model answered, from the records: after every
    // turn, so a model change counts right.
    const agentModels = status
      ? withTurnCounts(story.agentModels, status.models)
      : undefined;
    const settled = await this.patch(story, {
      ...storyOutcomeUpdate(story, outcome),
      ...(agentModels ? { agentModels } : {}),
    });
    const record = this.record(settled.id);
    for (const listener of this.turnListeners)
      listener({
        storyId: settled.id,
        projectId: settled.projectId,
        session: story.engineSessionId!,
        story: record?.payload,
        ...(outcome ? { outcome } : {}),
        ...(status?.lastReply ? { lastReply: status.lastReply } : {}),
      });
    this.pump();
  }

  private async sessionStatus(story: HostStory) {
    if (!story.engineSessionId) return undefined;
    const [status] = await this.host
      .call("status", {
        sessions: [story.engineSessionId],
        location: storyLocation(story.workspaceMode),
      })
      .catch(() => []);
    return status?.exists ? status : undefined;
  }

  /** Starts every queued story that can start now; says why the others wait. */
  private pump() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const now = Date.now();
    const queued = new Set<string>();
    for (const [projectId, records] of this.stories) {
      const path = this.projects.get(projectId);
      const projectStories = [...records.values()].map(({ story }) => story);
      for (const story of queuedStories(projectStories)) {
        queued.add(story.id);
        if (this.starting.has(story.id)) continue;
        if ((this.retryAt.get(story.id) ?? 0) > now) continue;
        const reason: StoryWaitReason | undefined = !this.host.api()
          ? { kind: "signed-out" }
          : !path
            ? { kind: "no-project" }
            : dependencyWait(story, projectStories);
        if (reason) {
          this.setWaiting(story, reason);
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
    void startStory(this.context(), story, projectPath)
      .then(
        (reason) => {
          if (reason) this.setWaiting(story, reason);
        },
        (error: unknown) =>
          this.setWaiting(story, {
            kind: "error",
            message: errorMessage(error),
          }),
      )
      .finally(() => {
        this.starting.delete(story.id);
        this.pump();
      });
    this.emitQueue();
  }

  private setWaiting(story: HostStory, reason: StoryWaitReason) {
    this.waiting.set(story.id, {
      storyId: story.id,
      projectId: story.projectId,
      title: story.title,
      reason,
    });
    const delay = retryDelay(reason);
    if (delay !== undefined) this.retryAt.set(story.id, Date.now() + delay);
  }

  private emitQueue() {
    const queue = this.queueState();
    const serialized = JSON.stringify(queue);
    if (serialized === this.lastQueue) return;
    this.lastQueue = serialized;
    this.host.emit({ type: "story-queue", queue });
  }

  /** What a start, a turn or an ending is given. */
  context(): StoryContext {
    const connection = this.host.api();
    if (!connection) throw new Error("Sign in to run user stories.");
    return {
      api: storyApi(connection),
      connection,
      preferences: this.preferences,
      desktop: this.host.desktop,
      call: (method, input) => this.host.call(method, input),
      patch: (story, update, extra) => this.patch(story, update, extra),
    };
  }

  /** The story's payload as the API last sent it, for the windows. */
  payload(storyId: string): unknown {
    return this.record(storyId)?.payload;
  }

  /** The project folder of a story's project, when this computer has it. */
  projectPath(projectId: string) {
    return this.projects.get(projectId);
  }

  /** The story as the service holds it, read from the API when it does not. */
  async current(storyId: string): Promise<HostStory> {
    const known = this.record(storyId);
    if (known) return known.story;
    const record = await this.api().get(storyId);
    this.remember(record);
    return record.story;
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
        const record = await this.api().update(story.id, update);
        this.remember(record);
        this.emitStory(record, extra);
        return record.story;
      });
    this.writes.set(story.id, write);
    void write.finally(() => {
      if (this.writes.get(story.id) === write) this.writes.delete(story.id);
    });
    return write;
  }

  /** A story deleted from the account: the service forgets it. */
  forget(story: HostStory) {
    this.stories.get(story.projectId)?.delete(story.id);
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
      const first = !this.stories.has(projectId);
      const records = await this.api().list(projectId);
      if (!this.projects.has(projectId)) return;
      const known = this.stories.get(projectId);
      this.stories.set(
        projectId,
        new Map(
          records.map((record) => [
            record.story.id,
            // A detail read since keeps what the summary leaves out.
            mergeRecord(known?.get(record.story.id), record),
          ]),
        ),
      );
      if (first) await this.recover(projectId);
    })()
      .catch(report)
      .finally(() => this.loading.delete(projectId));
    this.loading.set(projectId, load);
    return load;
  }

  /**
   * After Blame quits mid-turn (agents stop with the app), the stories it
   * left Running are settled from their records.
   */
  private async recover(projectId: string) {
    const left = [...(this.stories.get(projectId)?.values() ?? [])]
      .map(({ story }) => story)
      .filter(
        (story) =>
          // In review, Running means Approve & Merge, not the agent.
          story.status === "in-progress" &&
          story.agentStatus === "Running" &&
          story.engineSessionId &&
          !this.recovered.has(story.engineSessionId),
      );
    for (const story of left) this.recovered.add(story.engineSessionId!);
    // Each engine answers for its own sessions (this computer's, the VM's).
    const byLocation = new Map<EngineLocation, HostStory[]>();
    for (const story of left) {
      const location = storyLocation(story.workspaceMode);
      byLocation.set(location, [...(byLocation.get(location) ?? []), story]);
    }
    const statuses = (
      await Promise.all(
        [...byLocation].map(([location, stories]) =>
          this.host
            .call("status", {
              sessions: stories.map((story) => story.engineSessionId!),
              location,
            })
            .catch(() => []),
        ),
      )
    ).flat();
    for (const status of statuses) {
      if (status.running) continue;
      const story = left.find(
        (item) => item.engineSessionId === status.session,
      );
      if (!story) continue;
      await this.patch(story, {
        ...storyOutcomeUpdate(story, status.lastOutcome),
        ...(status.exists
          ? {}
          : {
              agentStatus: "Paused" as const,
              agentLastError: "The agent's conversation could not be found.",
            }),
      }).catch(report);
    }
  }

  private remember(record: StoryRecord) {
    const { projectId, id } = record.story;
    const stories = this.stories.get(projectId) ?? new Map();
    stories.set(id, mergeRecord(stories.get(id), record));
    this.stories.set(projectId, stories);
  }

  private record(storyId: string) {
    for (const stories of this.stories.values()) {
      const record = stories.get(storyId);
      if (record) return record;
    }
    return undefined;
  }

  private allStories() {
    return [...this.stories.values()].flatMap((stories) =>
      [...stories.values()].map(({ story }) => story),
    );
  }

  stop() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.reloadTimer) clearInterval(this.reloadTimer);
  }
}

function mergeRecord(
  known: StoryRecord | undefined,
  next: StoryRecord,
): StoryRecord {
  if (!known) return next;
  return {
    story: { ...known.story, ...next.story },
    payload: { ...(known.payload as object), ...(next.payload as object) },
  };
}

function report(error: unknown) {
  console.error("Story service:", errorMessage(error));
}
