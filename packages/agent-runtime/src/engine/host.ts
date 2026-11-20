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
  type UserBlock,
} from "@blame/engine-client";
import { runHostGh, type GhRunner } from "../pull-request.js";
import { setGitRunner } from "../runtime-git.js";
import type { ApiConnection } from "../types.js";
import type { RenderWebPage } from "../web-research-types.js";
import { CredentialResolver, type CredentialServices } from "./credentials.js";
import type {
  EngineHostEvent,
  EngineHostInput,
  EngineHostMethod,
  EngineHostResult,
  EngineMessage,
  EngineSessionSettings,
} from "./protocol.js";
import { quickChatConfig } from "./purposes/quick-chat.js";
import { remoteLogHandlers } from "./remote-log.js";
import { SessionHub } from "./session-hub.js";
import { taskHandlers } from "./tasks/handlers.js";
import { TaskRunner } from "./tasks/runner.js";
import { ToolSet, type ClientTool } from "./tool.js";
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
  /** How the git flows run git: through the main process, which reaches the runtime VM. */
  git?: (cwd: string, args: string[]) => Promise<string>;
  /** For tests: gh for Open PR (the person's own by default). */
  gh?: GhRunner;
  env?: NodeJS.ProcessEnv;
  onLog?(line: EngineLogLine): void;
  /** For tests: replaces parts of how credentials are found. */
  credentials?: Partial<CredentialServices>;
  /** For tests: the clock (a session's prompt carries the day it started). */
  now?: () => Date;
  /** For tests: more client tools beside the app's own. */
  extraTools?: ClientTool<never>[];
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
  private readonly approvals = new Map<string, Waiting>();
  private readonly earlyDecisions = new Map<string, "approved" | "denied">();
  private readonly supervisor: EngineSupervisor;
  private readonly hub: SessionHub;
  private readonly tools: ToolSet;
  private readonly credentials: CredentialResolver;
  private readonly options: EngineHostOptions;
  // Before `handlers`, which hand it out. A task is not watched like a
  // conversation (no activity events): a window that shows its progress
  // follows it.
  private readonly tasks = new TaskRunner(() => this.supervisor.client());

  constructor(options: EngineHostOptions) {
    this.options = options;
    if (options.git) setGitRunner(options.git);
    this.tools = new ToolSet([
      ...webResearchClientTools({
        connection: () => this.api,
        render: options.renderWebPage,
      }),
      ...(options.extraTools ?? []),
    ]);
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
          },
          options.env,
        ),
        {
          clientName: "blame-desktop",
          clientVersion: options.clientVersion,
          onLog: options.onLog,
          handlers: {
            tool: (params, context) =>
              this.tasks.handleTool(params, context) ??
              this.tools.handle(params, context),
            credential: (params) => this.credentials.resolve(params),
            approval: (params, { signal }) => this.approval(params, signal),
            ...logs,
          },
        },
      ),
    );
    this.supervisor.onStarted(() => this.credentials.engineRestarted());
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
      const promptDate = this.now();
      const config = this.config(session, settings, promptDate);
      const client = await this.supervisor.client();
      const opened = await client.createSession({ session, config });
      this.current.set(session, { config, promptDate });
      return { session: opened.session, head: opened.head };
    },
    configure: async ({ session, ...settings }) => {
      const client = await this.supervisor.client();
      return { changed: await this.applySettings(client, session, settings) };
    },
    send: async ({ session, message, delivery, settings }) => {
      const client = await this.supervisor.client();
      if (settings) await this.applySettings(client, session, settings);
      const input = await this.userInput(client, message);
      const accepted = await client.sendMessage({ session, input, delivery });
      this.hub.watch(session);
      return { turn: accepted.turn, started: accepted.started };
    },
    interrupt: async ({ session }) => {
      await (await this.supervisor.client()).interrupt({ session });
      return null;
    },
    compact: async ({ session }) => {
      await (await this.supervisor.client()).compact({ session });
      this.hub.watch(session);
      return null;
    },
    rewind: async ({ session, to, restoreWorkspace }) => {
      const client = await this.supervisor.client();
      const rewound = await client.rewind({
        session,
        to,
        restore_workspace: restoreWorkspace,
      });
      // A rewind can take a config change back with it.
      this.current.delete(session);
      return { finished: rewound.finished };
    },
    undoRewind: async ({ session }) => {
      await (await this.supervisor.client()).undoRewind({ session });
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
    follow: async ({ session, subscription }) => {
      this.hub.subscribe(session, subscription);
      return null;
    },
    unfollow: async ({ subscription }) => {
      this.hub.unsubscribe(subscription);
      return null;
    },
    running: async () => this.hub.running(),
    shutdown: async () => {
      await this.shutdown();
      return null;
    },
    ...taskHandlers({
      runner: this.tasks,
      clientTools: (names) => this.tools.specs(names),
      client: () => this.supervisor.client(),
      register: (session, known) => this.known.set(session, known),
      forget: (session) => {
        this.known.delete(session);
        this.current.delete(session);
      },
      gh: (cwd, args) => (this.options.gh ?? runHostGh)(cwd, args),
    }),
  };

  /** Stops following, ends running turns as interrupted and stops the engine. */
  async shutdown() {
    this.tasks.cancelAll();
    await this.hub.stop();
    for (const waiting of this.approvals.values()) waiting.resolve("denied");
    this.approvals.clear();
    await this.supervisor.stop();
    await this.credentials.close();
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
    const { model, projectId } = settings.settings;
    this.known.set(session, {
      projectId,
      credentialLabel: model.credentialLabel,
    });
    switch (settings.purpose) {
      case "quick-chat":
        return quickChatConfig(settings.settings, this.tools, promptDate);
    }
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
