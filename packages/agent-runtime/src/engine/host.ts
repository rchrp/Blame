// The engine host: the one owner of the app's engine (docs/engine-in-the-app.md).
// It starts `blame-engine`, answers what the engine asks, runs the client
// tools and hands every window the records of the sessions it shows.

import {
  EngineClient,
  EngineSupervisor,
  TranscriptReducer,
  localEngine,
  type EngineLogLine,
  type HostParamsOf,
  type JsonValue,
  type Limits,
  type SessionConfig,
  type TaskOutcome,
  type UserBlock,
} from "@blame/engine-client";
import { runHostGh, type GhRunner } from "../pull-request.js";
import { setGitRunner } from "../runtime-git.js";
import { mkdir } from "node:fs/promises";
import { posix } from "node:path";
import { listProjectMemories, saveProjectMemory } from "../cloud-api.js";
import {
  completionMemoryFile,
  takeCompletionMemory,
} from "../harness/completion-memory.js";
import {
  selectProjectMemory,
  type ProjectMemoryCandidate,
  type ProjectMemoryPersistence,
} from "../harness/project-memory.js";
import type { ApiConnection, ModelRecommendations } from "../types.js";
import type { RenderWebPage } from "../web-research-types.js";
import { CredentialResolver, type CredentialServices } from "./credentials.js";
import { deviceCredentials } from "./device-credentials.js";
import type { DesktopServices } from "./desktop-services.js";
export { attachmentKind, vmCredential } from "./host-helpers.js";
export type { VmEngineOptions } from "./host-helpers.js";

import type {
  DevelopmentStorySettings,
  EngineHostEvent,
  EngineHostInput,
  EngineHostMethod,
  EngineHostResult,
  EngineLocation,
  EngineMessage,
  EngineSessionRef,
  EngineSessionSettings,
} from "./protocol.js";
import {
  announcedTask,
  attachmentKind,
  conversationToolSession,
  sameJson,
  vmProviderCredential,
  type VmEngineOptions,
} from "./host-helpers.js";
import { Orchestrator } from "./orchestrator/service.js";
import { developmentStoryPurpose } from "./purposes/development-story.js";
import { purposeOf, type FirstMessageServices } from "./purposes/index.js";
import { purposeClientTools } from "./purposes/tool-sets.js";
import { parseOrchestratorWake } from "./orchestrator-protocol.js";
import { EngineProviders } from "./providers.js";
import { remoteLogHandlers } from "./remote-log.js";
import { SessionHub } from "./session-hub.js";
import { sessionStatus } from "./session-status.js";
import { storyHandlers } from "./stories/handlers.js";
import { StoryService } from "./stories/service.js";
import { taskHandlers, type TaskHost } from "./tasks/handlers.js";
import { runInitializationRepair } from "./tasks/project.js";
import { EngineTaskError, TaskRunner } from "./tasks/runner.js";
import { ToolSet, type ClientTool } from "./tool.js";
import {
  ConversationTools,
  McpConnections,
  clientToolGuards,
  clientToolPolicy,
  type PreviewRuntimeContext,
} from "./tools/index.js";
import { pickerSkills } from "./tools/skills.js";
import { webResearchClientTools } from "./tools/web-research.js";

export type EngineHostOptions = {
  /** The `blame-engine` binary (`engineBinaryPath()` in the desktop). */
  binary: string;
  /** The engine's own data directory, on a local disk. */
  dataDir: string;
  /** How the engine starts the harness runner, as a command line array. */
  harnessCommand?: string[];
  clientVersion: string;
  emit(event: EngineHostEvent): void;
  /** Desktop services, served by the main process. */
  renderWebPage?: RenderWebPage;
  /** For tests: how the git flows run git (main's `desktop.git` by default). */
  git?: DesktopServices["git"];
  /** For tests: gh for Open PR (the person's own by default). */
  gh?: GhRunner;
  /** The desktop services the conversations' tools use (`desktop-services.ts`). */
  desktop?: DesktopServices;
  /** Where the engine refreshes the models.dev catalog, when not models.dev. */
  catalogUrl?: string;
  /**
   * The runtime VM (Lima, WSL) where local-container workspaces live; absent
   * where there is none (Linux runs those on the host).
   */
  vm?: VmEngineOptions;
  env?: NodeJS.ProcessEnv;
  onLog?(line: EngineLogLine): void;
  /** For tests: replaces parts of how credentials are found. */
  credentials?: Partial<CredentialServices>;
  /** For tests: the clock (a session's prompt carries the day it started). */
  now?: () => Date;
  /** Where project memories are kept: the account's API by default (a file for benchmarks). */
  projectMemory?: ProjectMemoryPersistence;
  /**
   * Where the story service keeps which ended turns it told its listeners
   * about (a turn that ended while Blame was closed is told once, later).
   * Without it, that is kept in memory only.
   */
  storyLedgerFile?: string;
  /** Where the epics whose conversation runs here are kept (`orchestrator/state.ts`). */
  orchestratorStateFile?: string;
  /** For tests: the ranking stories' models are chosen from (the providers list's by default). */
  modelRanking?: () => Promise<ModelRecommendations>;
  /** For tests: more client tools beside the app's own. */
  extraTools?: ClientTool<never>[];
  /** For tests: more client tools, by name, for sessions of a purpose. */
  extraPurposeTools?: Partial<
    Record<EngineSessionSettings["purpose"], string[]>
  >;
};

type Waiting = {
  resolve(decision: "approved" | "denied"): void;
};

/**
 * The config a session runs with now, and the day its prompt was written,
 * which a rebuilt config keeps (see `applySettings`).
 */
type Current = { config: SessionConfig; promptDate: Date };

/** What the renderer told the host about a session; lost with the host, sent again on use. */
type Known = { projectId?: string; credentialLabel?: string };

export class EngineHost {
  private api: ApiConnection | undefined;
  private readonly known = new Map<string, Known>();
  private readonly current = new Map<string, Current>();
  /** Where each session's engine is, as the renderer named its workspace. */
  private readonly locations = new Map<string, EngineLocation>();
  /** Each conversation's preview, for the harness's dependency refresh. */
  private readonly previews = new Map<string, PreviewRuntimeContext>();
  /** Sessions created here whose first message is not sent yet. */
  private readonly awaitingFirst = new Map<string, EngineSessionSettings>();
  private readonly approvals = new Map<string, Waiting>();
  private readonly earlyDecisions = new Map<string, "approved" | "denied">();
  /** The native engine, then the VM's once a VM workspace needs it. */
  private readonly engines = new Map<EngineLocation, Engine>();
  private readonly tools: ToolSet;
  private readonly mcp = new McpConnections({
    log: (message, payload) => console.warn(message, payload ?? {}),
  });
  /**
   * Each conversation's own client tools, for the purpose builders. Deleting
   * a session (`deleteSession`) releases its tools.
   */
  readonly conversationTools: ConversationTools;
  private readonly credentials: CredentialResolver;
  private readonly providers: EngineProviders;
  /**
   * The life of every development story (`stories/service.ts`): its queue,
   * its starts, the end of each turn. The orchestrator calls it directly.
   */
  readonly stories: StoryService;
  /** The epics' conversations: their branch, tools, spend and waking. */
  readonly orchestrator: Orchestrator;
  private readonly options: EngineHostOptions;
  // Before `handlers`, which hand it out. A task is not watched like a
  // conversation (no activity events): a window that shows its progress
  // follows it, after the call that runs it.
  private readonly tasks = new TaskRunner(
    (location) => this.engineAt(location).supervisor.client(),
    (root) =>
      this.options.vm?.workspaceRoots.some(
        (vmRoot) => root === vmRoot || root.startsWith(`${vmRoot}/`),
      )
        ? "vm"
        : "host",
  );

  constructor(options: EngineHostOptions) {
    this.options = options;
    const git = options.git ?? options.desktop?.git;
    if (git) setGitRunner((cwd, args) => git({ cwd, args }));
    this.tools = new ToolSet(
      [
        ...webResearchClientTools({
          connection: () => this.api,
          render: options.renderWebPage ?? options.desktop?.renderWebPage,
        }),
        ...(options.extraTools ?? []),
      ],
      {
        policy: clientToolPolicy,
        guards: clientToolGuards,
        // A tool's image goes to the store of the engine that ran the call.
        putBlob: async (params, signal, session) =>
          (await this.engineFor({ session }).supervisor.client()).putBlob(
            params,
            { signal },
          ),
      },
    );
    this.conversationTools = new ConversationTools(this.tools, {
      ...options.desktop,
      connection: () => this.api,
      mcp: this.mcp,
      blameHost: {
        providers: async () =>
          (await this.providers.list(false)).credentials.map((credential) => ({
            provider: credential.providerId,
            label: credential.label,
            ...(credential.authMethod ? { auth: credential.authMethod } : {}),
            ...(credential.expiresAt
              ? { expiresAt: credential.expiresAt }
              : {}),
            ...(credential.baseUrl
              ? { endpoint: endpointHost(credential.baseUrl) }
              : {}),
          })),
        sessionFailures: (session) => this.sessionFailures(session),
      },
      // A story's repair_preview_initialization runs the repair task.
      repairInitialization: (input) =>
        runInitializationRepair(this.taskHost(), input),
      orchestratorTools: (session, epicId) =>
        this.orchestrator.tools(session, epicId),
    });
    const device = deviceCredentials(options.desktop);
    this.credentials = new CredentialResolver(
      {
        connection: () => this.api,
        ...(device ? { device } : {}),
        label: (session) => this.known.get(session)?.credentialLabel,
        ...options.credentials,
      },
      options.binary,
    );
    this.stories = new StoryService(
      {
        api: () => this.api,
        call: (method, input) => this.handlers[method](input),
        desktop: options.desktop ?? {},
        emit: (event) => options.emit(event),
        storedSessions: async (location) => {
          const client = await this.engineAt(location).supervisor.client();
          const { sessions } = await client.listSessions();
          return sessions.map(({ session }) => session);
        },
        holds: (story) => this.orchestrator.holds(story),
      },
      { ledgerFile: options.storyLedgerFile },
    );
    this.orchestrator = new Orchestrator(
      {
        api: () => this.api,
        stories: this.stories,
        call: (method, input) => this.handlers[method](input),
        client: () => this.engineAt("host").supervisor.client(),
        write: async (input) => {
          await this.sendMessage({ ...input, delivery: "turn" });
        },
        interrupt: async (session) => {
          await (await this.clientFor({ session })).interrupt({ session });
        },
        ...(git
          ? { git: (cwd: string, args: string[]) => git({ cwd, args }) }
          : {}),
        emit: (event) => options.emit(event),
        ...(options.modelRanking ? { ranking: options.modelRanking } : {}),
      },
      { stateFile: options.orchestratorStateFile },
    );
    // The native engine starts with the host: the catalog and every host
    // workspace use it.
    this.engineAt("host");
    this.providers = new EngineProviders({
      connection: () => this.api,
      catalog: async (refresh) =>
        (await this.engineAt("host").supervisor.client()).request(
          "catalog/list",
          { refresh },
        ),
      credentials: this.credentials,
      ...(device ? { device } : {}),
      engineBinary: options.binary,
      openExternal: async (url) => {
        await options.desktop?.openExternal?.({ url });
      },
    });
  }

  /**
   * An engine for a location, started on its first call: this computer's
   * runs `blame-engine` directly, the VM's through the runtime (Lima, WSL)
   * with the same JSON-RPC over stdio. Both answer to this host: credentials,
   * tools, approvals and replication to the API work alike.
   */
  private startEngine(location: EngineLocation): Engine {
    const options = this.options;
    const vm = options.vm;
    if (location === "vm" && !vm)
      throw new Error(
        "This workspace is in the Blame Runtime VM, which this computer does not use.",
      );
    const logs = remoteLogHandlers({
      connection: () => this.api,
      projectId: (session) => this.known.get(session)?.projectId,
    });
    const command = async () =>
      location === "vm"
        ? vm!.prepare()
        : localEngine(
            options.binary,
            {
              dataDir: options.dataDir,
              ...(options.harnessCommand
                ? { harnessCommand: JSON.stringify(options.harnessCommand) }
                : {}),
              ...(options.catalogUrl ? { catalogUrl: options.catalogUrl } : {}),
            },
            options.env,
          );
    const supervisor = new EngineSupervisor(async () =>
      EngineClient.start(await command(), {
        clientName: "blame-desktop",
        clientVersion: options.clientVersion,
        onLog: options.onLog,
        handlers: {
          tool: (params, context) =>
            this.tasks.handleTool(params, context) ??
            this.tools.handle(params, context),
          credential: async (params) => {
            const credential = await this.credentials.resolve(params);
            return location === "vm"
              ? vmProviderCredential(params.provider, credential, vm!)
              : credential;
          },
          approval: (params, { signal }) => this.approval(params, signal),
          harness: (params, { signal }) =>
            this.harnessQuestion(params, location, signal),
          ...logs,
        },
      }),
    );
    supervisor.onStarted(() => this.credentials.engineRestarted());
    const hub = new SessionHub(supervisor, (event) => {
      if (event.type !== "activity") return options.emit(event);
      if (!event.running)
        void this.saveCompletionMemory(event.session, location);
      this.stories.onActivity(event);
      void this.orchestrator.onActivity(event);
      const workspace = this.current.get(event.session)?.config.workspace_root;
      options.emit(workspace ? { ...event, workspace } : event);
    });
    return { supervisor, hub };
  }

  /**
   * What the workspace harness asks while it runs a call (`host/harness`):
   * the credentials of a command, or a dependency change for the preview.
   * Without the desktop (tests, the benchmark runner) there is no answer.
   */
  private async harnessQuestion(
    params: { session: string; method: string },
    location: EngineLocation,
    signal: AbortSignal,
  ): Promise<unknown> {
    const desktop = this.options.desktop;
    if (params.method === "commandCredentials")
      return (
        (await desktop?.commandCredentials?.({
          sessionId: params.session,
          location,
        })) ?? null
      );
    if (params.method === "refreshPreviewDependencies") {
      const preview = this.previews.get(params.session);
      if (!preview || !desktop?.refreshPreviewDependencies) return null;
      return desktop.refreshPreviewDependencies({
        ...preview,
        signal,
      } as never);
    }
    return null;
  }

  /**
   * A story's accepted finish_task may have left a memory for its project
   * (harness/completion-memory.ts): saved to the account when the turn
   * ends, as the agent runtime did after its own sessions. A VM story's
   * harness leaves it in the VM: it is taken from there (and removed, so it
   * is saved once).
   */
  private async saveCompletionMemory(
    session: string,
    location: EngineLocation = "host",
  ) {
    const config = this.current.get(session)?.config;
    const projectId = this.known.get(session)?.projectId;
    const api = this.api;
    if (config?.purpose !== "development-story" || !projectId || !api) return;
    const memory =
      location === "vm"
        ? await this.takeVmMemory(config.workspace_root, session)
        : await takeCompletionMemory(config.workspace_root, session);
    if (memory)
      await (this.options.projectMemory?.save ?? saveProjectMemory)(
        api,
        projectId,
        memory,
      ).catch(() => undefined);
  }

  private async takeVmMemory(workspaceRoot: string, session: string) {
    const text = await this.options.desktop
      ?.takeVmFile?.({
        path: completionMemoryFile(workspaceRoot, session, posix.join),
      })
      .catch(() => null);
    try {
      return text ? (JSON.parse(text) as ProjectMemoryCandidate) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A development story's agent with no person in it (the benchmark runner):
   * the story's own config and brief, run on this computer as a task that
   * ends through an accepted finish_task. The task's harness contract gets
   * `taskContract` on top of the story's. Resolves with how it ended; the
   * records stay with the engine (follow the session to read them).
   */
  async runStoryTask(input: {
    session: string;
    settings: DevelopmentStorySettings;
    instruction: string;
    limits?: Limits;
    taskContract?: { [key: string]: JsonValue };
    signal?: AbortSignal;
  }): Promise<{ session: string; outcome: TaskOutcome }> {
    const { session, settings } = input;
    const purpose = { purpose: "development-story" as const, settings };
    const promptDate = this.now();
    const story = await this.config(session, purpose, promptDate);
    const harness = (
      story.tool_options as {
        harness?: { taskContract?: { [key: string]: JsonValue } };
      }
    ).harness;
    const config: SessionConfig = {
      ...story,
      tool_options: {
        ...story.tool_options,
        harness: {
          ...harness,
          taskContract: { ...harness?.taskContract, ...input.taskContract },
        },
      },
      limits: { ...story.limits, ...input.limits },
      checkpoints: false,
      kind: { kind: "task", replicate: false },
    };
    this.current.set(session, { config, promptDate });
    const brief = await developmentStoryPurpose.firstMessage!(
      settings,
      { text: input.instruction },
      this.firstMessageServices,
    );
    try {
      await this.tasks.run(
        { config, instruction: brief.text, result: (value) => value },
        { session, signal: input.signal, what: "The story task" },
      );
      return { session, outcome: { status: "completed" } as TaskOutcome };
    } catch (error) {
      if (error instanceof EngineTaskError)
        return { session, outcome: error.outcome };
      throw error;
    } finally {
      await this.saveCompletionMemory(session);
    }
  }

  /** Runs one call of the renderer (through the main process). */
  async call<M extends EngineHostMethod>(
    method: M,
    input: EngineHostInput<M>,
  ): Promise<EngineHostResult<M>> {
    const handler = this.handlers[method] as (
      input: EngineHostInput<M>,
    ) => Promise<EngineHostResult<M>>;
    // A task the renderer named: following it waits for its session.
    const task = announcedTask(method, input);
    if (!task) return handler(input);
    this.tasks.announce(task);
    try {
      return await handler(input);
    } finally {
      this.tasks.settled(task);
    }
  }

  private readonly handlers: {
    [M in EngineHostMethod]: (
      input: EngineHostInput<M>,
    ) => Promise<EngineHostResult<M>>;
  } = {
    connect: async ({ api }) => {
      this.api = api ?? undefined;
      // Signed in: the stories of the projects it knows are read again;
      // another account starts over.
      this.stories.connected(this.api);
      this.orchestrator.connected();
      return null;
    },
    createSession: async ({ session, ...settings }) => {
      const workspace = purposeOf(settings).workspace(
        settings.settings,
        session,
      );
      const engine = this.engineAt(workspace.location);
      // A scratch workspace (the new-project assistant) exists before its
      // agent. A VM workspace is the story's worktree, made by the desktop.
      if (workspace.location === "host")
        await mkdir(workspace.root, { recursive: true });
      // An epic's branch is made, and written to the epic, first.
      if (settings.purpose === "orchestrator")
        await this.orchestrator.prepareSession(session, settings.settings);
      const promptDate = this.now();
      const config = await this.config(session, settings, promptDate);
      const client = await engine.supervisor.client();
      const opened = await client.createSession({ session, config });
      this.locations.set(session, workspace.location);
      this.current.set(session, { config, promptDate });
      this.awaitingFirst.set(session, settings);
      return { session: opened.session, head: opened.head };
    },
    configure: async ({ session, ...settings }) => {
      const client = await this.clientFor({ session, settings });
      return { changed: await this.applySettings(client, session, settings) };
    },
    send: async (input) => {
      // A wake is the host's alone: a window never writes one.
      if (isWake(input.message))
        throw new Error("Only Blame writes the orchestrator's wake.");
      return this.sendMessage(input);
    },
    withdraw: async ({ turn, ...ref }) => {
      await (
        await this.clientFor(ref)
      ).withdraw({ session: ref.session, turn });
      return null;
    },
    promote: async ({ turn, ...ref }) => {
      const accepted = await (
        await this.clientFor(ref)
      ).promote({ session: ref.session, turn });
      this.engineFor(ref).hub.watch(ref.session, accepted.turn);
      return { turn: accepted.turn };
    },
    interrupt: async (ref) => {
      await this.orchestrator.interrupted(ref.session);
      await (await this.clientFor(ref)).interrupt({ session: ref.session });
      return null;
    },
    compact: async (ref) => {
      await (await this.clientFor(ref)).compact({ session: ref.session });
      this.engineFor(ref).hub.watch(ref.session);
      return null;
    },
    rewind: async ({ session, location, to, restoreWorkspace }) => {
      const client = await this.clientFor({ session, location });
      const rewound = await client.rewind({
        session,
        to,
        restore_workspace: restoreWorkspace,
      });
      // A rewind can take a config change back with it.
      this.current.delete(session);
      return { finished: rewound.finished };
    },
    undoRewind: async (ref) => {
      const session = ref.session;
      await (await this.clientFor(ref)).undoRewind({ session });
      this.current.delete(session);
      return null;
    },
    resolveApproval: async ({ session, call, decision }) => {
      const key = `${session}\u0000${call}`;
      const waiting = this.approvals.get(key);
      if (waiting) {
        waiting.resolve(decision);
        return true;
      }
      // The record reached the window before the engine's request reached us.
      this.earlyDecisions.set(key, decision);
      setTimeout(() => this.earlyDecisions.delete(key), 60_000).unref?.();
      return true;
    },
    follow: async ({ session, location, subscription }) => {
      // A task called just before is followed once the engine has it.
      await this.tasks.whenCreated(session);
      this.engineFor({ session, location }).hub.subscribe(
        session,
        subscription,
      );
      return null;
    },
    unfollow: async ({ subscription }) => {
      for (const engine of this.engines.values())
        engine.hub.unsubscribe(subscription);
      return null;
    },
    running: async () =>
      [...this.engines.values()].flatMap((engine) => engine.hub.running()),
    status: async ({ sessions, location }) => {
      const engine = this.engineAt(location ?? "host");
      const client = await engine.supervisor.client();
      const running = new Set(engine.hub.running());
      return Promise.all(
        sessions.map((session) => sessionStatus(client, session, running)),
      );
    },
    providers: ({ refresh }) => this.providers.list(refresh ?? false),
    saveCredential: (input) => this.providers.saveCredential(input),
    deleteCredential: ({ id }) => this.providers.deleteCredential(id),
    moveCredential: (input) => this.providers.moveCredential(input),
    credentialStorage: () => this.providers.credentialStorage(),
    signInChatGpt: ({ label, storage }) =>
      this.providers.signInChatGpt(label, storage),
    claudeCodeStatus: () => this.providers.claudeCodeStatus(),
    connectClaudeCode: ({ label }) => this.providers.connectClaudeCode(label),
    planUsage: (input) => this.providers.planUsage(input),
    listSkills: ({ workspaceRoot }) => pickerSkills({ workspaceRoot }),
    shutdown: async () => {
      await this.shutdown();
      return null;
    },
    epicState: ({ epicId }) => this.orchestrator.epicState(epicId),
    epicChanged: ({ epicId }) => this.orchestrator.changed(epicId),
    // The service is made in the constructor, after these handlers.
    ...storyHandlers(
      () => this.stories,
      // A story a person acts on is theirs through the epic's pause.
      (storyId) => this.orchestrator.touched(storyId),
    ),
    ...taskHandlers(this.taskHost()),
  };

  /** `send`, for a window or the host itself; resolves once the message is in the records. */
  private async sendMessage({
    session,
    location,
    message,
    delivery,
    settings,
  }: EngineHostInput<"send">) {
    const engine = this.engineFor({ session, location, settings });
    const client = await engine.supervisor.client();
    if (settings) await this.applySettings(client, session, settings);
    const first = this.awaitingFirst.get(session);
    const decorate = first && purposeOf(first).firstMessage;
    const text = decorate
      ? await decorate(first.settings, message, this.firstMessageServices)
      : message;
    const input = await this.userInput(client, text);
    const accepted = await client.sendMessage({ session, input, delivery });
    this.awaitingFirst.delete(session);
    engine.hub.watch(session, accepted.turn);
    return { turn: accepted.turn, started: accepted.started };
  }

  /** What the task handlers use of the host. */
  private taskHost(): TaskHost {
    return {
      runner: this.tasks,
      clientTools: (names) => this.tools.specs(names),
      client: (location) =>
        this.engineAt(location ?? "host").supervisor.client(),
      register: (session, known) => this.known.set(session, known),
      forget: (session) => {
        this.known.delete(session);
        this.current.delete(session);
        this.locations.delete(session);
        this.awaitingFirst.delete(session);
        this.conversationTools.release(session);
      },
      gh: (cwd, args) => (this.options.gh ?? runHostGh)(cwd, args),
      openAuthorization: async (url) => {
        await this.options.desktop?.openExternal?.({
          url,
          mcpAuthorization: true,
        });
      },
    };
  }

  /** Stops following, ends running turns as interrupted and stops the engine. */
  async shutdown() {
    this.stories.stop();
    this.orchestrator.stop();
    this.tasks.cancelAll();
    await Promise.all(
      [...this.engines.values()].map((engine) => engine.hub.stop()),
    );
    for (const waiting of this.approvals.values()) waiting.resolve("denied");
    this.approvals.clear();
    // Every engine ends its turns as interrupted and exits, the VM's too:
    // local agents stop with the app.
    await Promise.all(
      [...this.engines.values()].map((engine) => engine.supervisor.stop()),
    );
    await this.credentials.close();
    await this.mcp.close();
  }

  /**
   * Sets the config the settings build, unless it is the one the session
   * already has: an unchanged config would add a record to every message.
   * The prompt keeps the day the conversation started, so a message sent on
   * a later day does not rewrite it and lose the provider's prompt cache.
   */
  private async applySettings(
    client: EngineClient,
    session: string,
    settings: EngineSessionSettings,
  ): Promise<boolean> {
    const current = await this.currentConfig(client, session);
    const config = await this.config(session, settings, current.promptDate);
    if (sameJson(config, current.config)) return false;
    await client.configure({ session, config });
    this.current.set(session, { config, promptDate: current.promptDate });
    return true;
  }

  /** The config in effect, from the session's records when not known here. */
  private async currentConfig(client: EngineClient, session: string) {
    const known = this.current.get(session);
    if (known) return known;
    const reducer = new TranscriptReducer();
    let firstAtMs: number | undefined;
    for (;;) {
      const page = await client.readRecords({
        session,
        after: reducer.lastSeq,
        limit: 1000,
      });
      firstAtMs ??= page.records[0]?.at_ms;
      reducer.applyRecords(page.records);
      if (!page.records.length || reducer.lastSeq >= page.head) break;
    }
    const config = reducer.snapshot().config;
    if (!config) throw new Error(`Session ${session} has no configuration.`);
    const current = { config, promptDate: new Date(firstAtMs ?? Date.now()) };
    this.current.set(session, current);
    return current;
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }

  private async config(
    session: string,
    given: EngineSessionSettings,
    promptDate: Date,
  ): Promise<SessionConfig> {
    // An epic's conversation runs on the epic's model, read with the epic.
    const settings: EngineSessionSettings =
      given.purpose === "orchestrator"
        ? {
            purpose: "orchestrator",
            settings: await this.orchestrator.resolve(session, given.settings),
          }
        : given;
    const model =
      settings.purpose === "orchestrator"
        ? (settings.settings as Awaited<ReturnType<Orchestrator["resolve"]>>)
            .resolved.model
        : settings.settings.model;
    const projectId =
      "projectId" in settings.settings
        ? settings.settings.projectId
        : undefined;
    this.known.set(session, {
      projectId,
      credentialLabel: model.credentialLabel,
    });
    const clientTools = [
      ...purposeClientTools[settings.purpose],
      ...(this.options.extraPurposeTools?.[settings.purpose] ?? []),
    ];
    // Listed once per conversation and host lifetime, so its config (and the
    // provider's prompt cache) stays the same from one message to the next.
    const toolSession = conversationToolSession(
      session,
      settings,
      purposeOf(settings).workspace(settings.settings, session).root,
    );
    if (toolSession.preview) this.previews.set(session, toolSession.preview);
    else this.previews.delete(session);
    const own = await this.conversationTools.ensure(toolSession);
    const config = purposeOf(settings).config(settings.settings, session, {
      tools: this.tools,
      clientTools,
      toolNames: [...clientTools, ...own.specs.map((spec) => spec.name)],
      promptDate,
    });
    return {
      ...config,
      client_tools: [...(config.client_tools ?? []), ...own.specs],
      ...(own.prompt
        ? { system_prompt: `${config.system_prompt}\n\n${own.prompt}` }
        : {}),
    };
  }

  /** The latest model request failures of a conversation, for `blame_inspect`. */
  private async sessionFailures(session: string): Promise<string[]> {
    const client = await this.engineFor({ session }).supervisor.client();
    const { head } = await client.readRecords({ session, after: 0, limit: 1 });
    const { records } = await client.readRecords({
      session,
      after: Math.max(0, head - 400),
      limit: 400,
    });
    return records.flatMap((record) =>
      record.type === "request_failed"
        ? [`${record.error.kind}: ${record.error.message}`.slice(0, 400)]
        : [],
    );
  }

  /** The engine for a workspace's location, started on first use. */
  private engineAt(location: EngineLocation): Engine {
    let engine = this.engines.get(location);
    if (!engine) {
      engine = this.startEngine(location);
      this.engines.set(location, engine);
    }
    return engine;
  }

  /** The engine of a session: named by the call, its settings, or remembered. */
  private engineFor(
    ref: EngineSessionRef & { settings?: EngineSessionSettings },
  ) {
    const location =
      ref.location ??
      (ref.settings
        ? purposeOf(ref.settings).workspace(ref.settings.settings, ref.session)
            .location
        : undefined) ??
      this.locations.get(ref.session) ??
      "host";
    this.locations.set(ref.session, location);
    return this.engineAt(location);
  }

  private clientFor(
    ref: EngineSessionRef & { settings?: EngineSessionSettings },
  ) {
    return this.engineFor(ref).supervisor.client();
  }

  /** What the first message of a conversation may carry beside the person's words. */
  private readonly firstMessageServices: FirstMessageServices = {
    projectMemory: async ({ projectId, workspaceRoot, objective }) => {
      const api = this.api;
      if (!api) return undefined;
      const records = await (
        this.options.projectMemory?.list ?? listProjectMemories
      )(api, projectId);
      const selection = await selectProjectMemory({
        objective,
        records,
        workspaceRoot,
      });
      return selection.briefing;
    },
  };

  private async userInput(
    client: EngineClient,
    message: EngineMessage,
  ): Promise<UserBlock[]> {
    const blocks: UserBlock[] = [];
    if (message.text.trim()) blocks.push({ type: "text", text: message.text });
    for (const attachment of message.attachments ?? []) {
      const kind = attachmentKind(attachment.mediaType);
      if (!kind)
        throw new Error(
          `${attachment.name} cannot be read by the agent: attach images, PDFs or text files.`,
        );
      const blob = await client.putBlob({
        media_type: attachment.mediaType,
        data: attachment.data,
      });
      blocks.push(
        kind === "image"
          ? { type: "image", blob }
          : { type: "document", blob, name: attachment.name },
      );
    }
    if (message.context?.trim())
      blocks.push({ type: "context", text: message.context });
    if (message.ultra) blocks.push({ type: "ultra" });
    if (!blocks.length) throw new Error("The message is empty.");
    return blocks;
  }

  private async approval(
    params: HostParamsOf<"host/approval">,
    signal: AbortSignal,
  ): Promise<{ decision: "approved" | "denied" }> {
    const auto = await this.orchestrator
      .approval(params)
      .catch(() => undefined);
    if (auto) return { decision: auto };
    const key = `${params.session}\u0000${params.call}`;
    const early = this.earlyDecisions.get(key);
    if (early) {
      this.earlyDecisions.delete(key);
      return Promise.resolve({ decision: early });
    }
    // The person answers from the conversation, where the pending call shows.
    return new Promise((resolve) => {
      const done = (decision: "approved" | "denied") => {
        this.approvals.delete(key);
        resolve({ decision });
      };
      this.approvals.set(key, { resolve: done });
      signal.addEventListener("abort", () => this.approvals.delete(key), {
        once: true,
      });
    });
  }
}

type Engine = { supervisor: EngineSupervisor; hub: SessionHub };

/** A message that reads as the orchestrator's wake. */
function isWake(message: EngineMessage) {
  return (
    message.context !== undefined &&
    parseOrchestratorWake([{ type: "context", text: message.context }]) !==
      undefined
  );
}

/** The host of a credential's endpoint: its path and query may carry secrets. */
function endpointHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return "(invalid URL)";
  }
}
