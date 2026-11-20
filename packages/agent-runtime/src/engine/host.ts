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
  type SessionConfig,
  type Transcript,
  type UserBlock,
} from "@blame/engine-client";
import { mkdir } from "node:fs/promises";
import { listProjectMemories } from "../cloud-api.js";
import { selectProjectMemory } from "../harness/project-memory.js";
import type { ApiConnection } from "../types.js";
import type { RenderWebPage } from "../web-research-types.js";
import { CredentialResolver, type CredentialServices } from "./credentials.js";
import type { DesktopServices } from "./desktop-services.js";
import type {
  EngineHostEvent,
  EngineHostInput,
  EngineHostMethod,
  EngineHostResult,
  EngineLocation,
  EngineMessage,
  EngineSessionRef,
  EngineSessionSettings,
  EngineSessionStatus,
} from "./protocol.js";
import { purposeOf, type FirstMessageServices } from "./purposes/index.js";
import { purposeClientTools } from "./purposes/tool-sets.js";
import { EngineProviders } from "./providers.js";
import { remoteLogHandlers } from "./remote-log.js";
import { SessionHub } from "./session-hub.js";
import { ToolSet, type ClientTool } from "./tool.js";
import {
  ConversationTools,
  McpConnections,
  clientToolGuards,
  clientToolPolicy,
} from "./tools/index.js";
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
  /** The desktop services the conversations' tools use (`desktop-services.ts`). */
  desktop?: DesktopServices;
  /** Where the engine refreshes the models.dev catalog, when not models.dev. */
  catalogUrl?: string;
  env?: NodeJS.ProcessEnv;
  onLog?(line: EngineLogLine): void;
  /** For tests: replaces parts of how credentials are found. */
  credentials?: Partial<CredentialServices>;
  /** For tests: the clock (a session's prompt carries the day it started). */
  now?: () => Date;
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
  /** Sessions created here whose first message is not sent yet. */
  private readonly awaitingFirst = new Map<string, EngineSessionSettings>();
  private readonly approvals = new Map<string, Waiting>();
  private readonly earlyDecisions = new Map<string, "approved" | "denied">();
  private readonly supervisor: EngineSupervisor;
  private readonly hub: SessionHub;
  private readonly tools: ToolSet;
  private readonly mcp = new McpConnections({
    log: (message, payload) => console.warn(message, payload ?? {}),
  });
  /** Each conversation's own client tools, for the purpose builders. */
  readonly conversationTools: ConversationTools;
  private readonly credentials: CredentialResolver;
  private readonly providers: EngineProviders;
  private readonly options: EngineHostOptions;

  constructor(options: EngineHostOptions) {
    this.options = options;
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
        putBlob: async (params, signal) =>
          (await this.supervisor.client()).putBlob(params, { signal }),
      },
    );
    this.conversationTools = new ConversationTools(this.tools, {
      ...options.desktop,
      connection: () => this.api,
      mcp: this.mcp,
    });
    this.credentials = new CredentialResolver(
      {
        connection: () => this.api,
        label: (session) => this.known.get(session)?.credentialLabel,
        ...options.credentials,
      },
      options.binary,
    );
    const logs = remoteLogHandlers({
      connection: () => this.api,
      projectId: (session) => this.known.get(session)?.projectId,
    });
    this.supervisor = new EngineSupervisor(() =>
      EngineClient.start(
        localEngine(
          options.binary,
          {
            dataDir: options.dataDir,
            ...(options.harnessCommand
              ? { harnessCommand: JSON.stringify(options.harnessCommand) }
              : {}),
            ...(options.catalogUrl ? { catalogUrl: options.catalogUrl } : {}),
          },
          options.env,
        ),
        {
          clientName: "blame-desktop",
          clientVersion: options.clientVersion,
          onLog: options.onLog,
          handlers: {
            tool: (params, context) => this.tools.handle(params, context),
            credential: (params) => this.credentials.resolve(params),
            approval: (params, { signal }) => this.approval(params, signal),
            ...logs,
          },
        },
      ),
    );
    this.supervisor.onStarted(() => this.credentials.engineRestarted());
    this.providers = new EngineProviders({
      connection: () => this.api,
      catalog: async (refresh) =>
        (await this.supervisor.client()).request("catalog/list", { refresh }),
      credentials: this.credentials,
      engineBinary: options.binary,
      openExternal: async (url) => {
        await options.desktop?.openExternal?.({ url });
      },
    });
    this.hub = new SessionHub(this.supervisor, options.emit);
  }

  /** Runs one call of the renderer (through the main process). */
  async call<M extends EngineHostMethod>(
    method: M,
    input: EngineHostInput<M>,
  ): Promise<EngineHostResult<M>> {
    const handler = this.handlers[method] as (
      input: EngineHostInput<M>,
    ) => Promise<EngineHostResult<M>>;
    return handler(input);
  }

  private readonly handlers: {
    [M in EngineHostMethod]: (
      input: EngineHostInput<M>,
    ) => Promise<EngineHostResult<M>>;
  } = {
    connect: async ({ api }) => {
      this.api = api ?? undefined;
      return null;
    },
    createSession: async ({ session, ...settings }) => {
      const workspace = purposeOf(settings).workspace(
        settings.settings,
        session,
      );
      const engine = this.engineAt(workspace.location);
      // A scratch workspace (the new-project assistant) exists before its agent.
      await mkdir(workspace.root, { recursive: true });
      const promptDate = this.now();
      const config = this.config(session, settings, promptDate);
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
    send: async ({ session, location, message, delivery, settings }) => {
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
      engine.hub.watch(session);
      return { turn: accepted.turn, started: accepted.started };
    },
    interrupt: async (ref) => {
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
      this.engineFor({ session, location }).hub.subscribe(
        session,
        subscription,
      );
      return null;
    },
    unfollow: async ({ subscription }) => {
      this.hub.unsubscribe(subscription);
      return null;
    },
    running: async () => this.hub.running(),
    status: async ({ sessions, location }) => {
      const engine = this.engineAt(location ?? "host");
      const client = await engine.supervisor.client();
      const running = new Set(engine.hub.running());
      return Promise.all(
        sessions.map((session) => this.sessionStatus(client, session, running)),
      );
    },
    providers: ({ refresh }) => this.providers.list(refresh ?? false),
    saveCredential: (input) => this.providers.saveCredential(input),
    deleteCredential: ({ id }) => this.providers.deleteCredential(id),
    signInChatGpt: ({ label }) => this.providers.signInChatGpt(label),
    claudeCodeStatus: () => this.providers.claudeCodeStatus(),
    connectClaudeCode: ({ label }) => this.providers.connectClaudeCode(label),
    planUsage: (input) => this.providers.planUsage(input),
    shutdown: async () => {
      await this.shutdown();
      return null;
    },
  };

  /** Stops following, ends running turns as interrupted and stops the engine. */
  async shutdown() {
    await this.hub.stop();
    for (const waiting of this.approvals.values()) waiting.resolve("denied");
    this.approvals.clear();
    await this.supervisor.stop();
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
    const config = this.config(session, settings, current.promptDate);
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

  private config(
    session: string,
    settings: EngineSessionSettings,
    promptDate: Date,
  ): SessionConfig {
    const { model } = settings.settings;
    const projectId =
      "projectId" in settings.settings
        ? settings.settings.projectId
        : undefined;
    this.known.set(session, {
      projectId,
      credentialLabel: model.credentialLabel,
    });
    return purposeOf(settings).config(settings.settings, session, {
      tools: this.tools,
      clientTools: [
        ...purposeClientTools[settings.purpose],
        ...(this.options.extraPurposeTools?.[settings.purpose] ?? []),
      ],
      promptDate,
    });
  }

  /**
   * The engine for a workspace's location. Only this computer's exists: a
   * workspace in the Blame Runtime VM needs an engine running inside it,
   * which is one more location here (`limaEngine`/`wslEngine` build its
   * command) without any change to purposes or the renderer.
   */
  private engineAt(location: EngineLocation) {
    if (location === "vm")
      throw new Error(
        "This story's worktree is inside the Blame Runtime VM, where Blame's agent engine does not run yet. Run the story in Direct mode, or with Cloud Preview, for now.",
      );
    return { supervisor: this.supervisor, hub: this.hub };
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
      const records = await listProjectMemories(api, projectId);
      const selection = await selectProjectMemory({
        objective,
        records,
        workspaceRoot,
      });
      return selection.briefing;
    },
  };

  /** Where a session stands, from its records (it is opened if needed). */
  private async sessionStatus(
    client: EngineClient,
    session: string,
    running: ReadonlySet<string>,
  ): Promise<EngineSessionStatus> {
    const reducer = new TranscriptReducer();
    try {
      for (;;) {
        const page = await client.readRecords({
          session,
          after: reducer.lastSeq,
          limit: 1000,
        });
        reducer.applyRecords(page.records);
        if (!page.records.length || reducer.lastSeq >= page.head) break;
      }
    } catch {
      return { session, exists: false, running: false, turns: 0 };
    }
    const transcript = reducer.snapshot();
    const ended = transcript.turns.filter((turn) => turn.outcome).at(-1);
    const last = ended?.outcome;
    const reply = ended ? lastReply(transcript, ended.turn) : undefined;
    return {
      session,
      exists: true,
      running: running.has(session) || transcript.runningTurn !== undefined,
      ...(last ? { lastOutcome: last } : {}),
      ...(reply ? { lastReply: reply } : {}),
      turns: transcript.turns.length,
    };
  }

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
    if (!blocks.length) throw new Error("The message is empty.");
    return blocks;
  }

  private approval(
    params: HostParamsOf<"host/approval">,
    signal: AbortSignal,
  ): Promise<{ decision: "approved" | "denied" }> {
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

const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const textTypes =
  /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|typescript|toml|x-sh|sql)$)/;

/** What the providers can read: images, PDFs and text, nothing else. */
export function attachmentKind(
  mediaType: string,
): "image" | "document" | undefined {
  if (imageTypes.has(mediaType)) return "image";
  if (mediaType === "application/pdf" || textTypes.test(mediaType))
    return "document";
  return undefined;
}

/** Equal as JSON, whatever the order of object keys (the engine's differs). */
function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The summary a turn handed finish_task, or else the last thing it said. */
function lastReply(transcript: Transcript, turn: string): string | undefined {
  let text: string | undefined;
  for (const item of transcript.items) {
    if (!("turn" in item) || item.turn !== turn) continue;
    if (item.kind === "text" && item.text.trim()) text = item.text.trim();
    if (
      item.kind === "tool_call" &&
      item.name === "finish_task" &&
      item.state === "completed"
    ) {
      const input = item.input;
      const summary =
        input && typeof input === "object" && !Array.isArray(input)
          ? input.summary
          : undefined;
      if (typeof summary === "string" && summary.trim()) return summary.trim();
    }
  }
  return text;
}
