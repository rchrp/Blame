import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  previewDevtoolsBoundedArguments,
  previewDevtoolsTimeoutMarginMs,
  previewDevtoolsToolTimeoutMs,
} from "@blame/agent-runtime";
import { previewNavigationAllowed } from "../preview-browser/preview-navigation-policy.ts";
import { runtimeHostPath } from "../workspace-runtime.ts";
import {
  AgentBrowserError,
  agentBrowserSession,
  runAgentBrowser,
  type AgentBrowserRun,
} from "./agent-browser-cli.ts";
import {
  PreviewDevtoolsPageState,
  type PreviewReconnectReason,
} from "./preview-devtools-page-state.ts";
import { applyEmulation } from "./preview-devtools-emulation.ts";
import {
  previewDevtoolsToolExists,
  previewDevtoolsTools,
  runPreviewDevtoolsTool,
  type PreviewToolContext,
  type PreviewToolResult,
} from "./preview-devtools-tools.ts";
import { uploadFilePaths } from "./preview-devtools-uploads.ts";

// Runs the agent's browser tools on its preview page through agent-browser.
// Each scope keeps one CDP endpoint, a single-page proxy with its own
// token, and one agent-browser session attached to it. When the endpoint
// closes (page gone, timeout reset), the next call opens a new one and puts
// back the emulation and page the agent had.

export type PreviewDevtoolsEndpoint = {
  close(): Promise<void>;
  closed: Promise<void>;
  // Where the agent's page is now.
  pageUrl?(): string;
  // The page's size before emulation, for emulate's viewport: null.
  viewport?: { height: number; width: number };
  wsEndpoint: string;
};

export type PreviewDevtoolsContext = {
  // Opens a fresh single-page CDP proxy for this scope.
  openEndpoint(): Promise<PreviewDevtoolsEndpoint>;
  pageIdentity?: string;
  previewOrigin?: string;
  scope: string;
  signal?: AbortSignal;
  worktree: string;
};

export type PreviewDevtoolsCall = PreviewDevtoolsContext & {
  arguments?: Record<string, unknown>;
  currentUrl: string;
  toolName: string;
};

type RunCommand = (input: AgentBrowserRun) => Promise<Record<string, unknown>>;

type Connection = {
  artifacts: string;
  // The endpoint closed: the next call opens a new connection.
  closed: boolean;
  disposed?: boolean;
  endpoint: PreviewDevtoolsEndpoint;
  // Told to the agent with the first result after a reconnection.
  notice?: string;
  pageIdentity?: string;
  reconnected?: PreviewReconnectReason;
  restored?: Promise<void>;
  session: string;
  // A command ran, so the session's daemon may be running.
  started?: boolean;
  workspace?: string;
  worktree: string;
};

type PendingConnection = {
  connection: Promise<Connection>;
  value?: Connection;
};

const defaultViewport = { height: 900, width: 1440 };

export class PreviewDevtoolsService {
  private readonly connections = new Map<string, PendingConnection>();
  private readonly pageState = new PreviewDevtoolsPageState();
  private readonly run: RunCommand;

  constructor(run: RunCommand = runAgentBrowser) {
    this.run = run;
  }

  listTools() {
    return Promise.resolve(previewDevtoolsTools);
  }

  async call(input: PreviewDevtoolsCall): Promise<PreviewToolResult> {
    input.signal?.throwIfAborted();
    if (!previewDevtoolsToolExists(input.toolName))
      throw new Error(
        `Preview DevTools tool is unavailable: ${input.toolName}`,
      );
    const scope = requiredValue(input.scope, "scope");
    const connection = await abortable(
      this.connection(input).connection,
      input.signal,
    );
    try {
      await abortable(
        (connection.restored ??= this.restore(connection, input)),
        input.signal,
      );
    } catch (error) {
      // The next call starts over with a new connection.
      this.disposeScope(
        scope,
        input.signal?.aborted ? "cancelled" : "connection",
      );
      throw new Error(
        `Preview DevTools could not attach to the preview page: the browser connection closed (${errorMessage(error)}).`,
        { cause: error },
      );
    }
    const notice = connection.notice;
    connection.notice = undefined;
    const argumentsValue = previewDevtoolsBoundedArguments(
      input.toolName,
      input.arguments ?? {},
    );
    const timeout = previewDevtoolsToolTimeoutMs(input.toolName, {
      arguments: argumentsValue,
    });
    try {
      const result = await runPreviewDevtoolsTool(
        input.toolName,
        argumentsValue,
        this.toolContext(connection, input, timeout),
      );
      this.pageState.record(
        scope,
        input.toolName,
        argumentsValue,
        connection.endpoint.pageUrl?.(),
      );
      return notice ? withNotice(result, notice) : result;
    } catch (error) {
      const reason: PreviewReconnectReason | undefined = input.signal?.aborted
        ? "cancelled"
        : error instanceof AgentBrowserError && error.unanswered
          ? "timeout"
          : connection.closed || lostConnection(error)
            ? "connection"
            : undefined;
      // A stuck command holds the session's CDP connection: closing the
      // endpoint frees it, and the next call starts clean.
      if (reason) this.disposeScope(scope, reason);
      if (reason === "timeout")
        throw new Error(
          `Preview DevTools ${input.toolName} did not finish within ${Math.round(timeout / 1000)} s. The browser connection was reset so the next call starts clean; the page keeps its address and emulation.`,
          { cause: error },
        );
      if (reason)
        throw new Error(
          `Preview DevTools ${input.toolName} failed: the browser connection closed (${errorMessage(error)}). The next call reconnects.`,
          { cause: error },
        );
      // The page's answer, such as an element not found: the agent reads it.
      return {
        content: [{ text: errorMessage(error), type: "text" }],
        isError: true,
      };
    }
  }

  async dispose() {
    const pending = Array.from(this.connections.values());
    this.connections.clear();
    await Promise.allSettled(
      pending.map(async ({ connection }) => this.close(await connection)),
    );
  }

  disposeScope(scope: string, reason: PreviewReconnectReason = "preview") {
    const normalized = scope.trim();
    const pending = this.connections.get(normalized);
    if (!pending) return;
    this.pageState.closed(normalized, reason);
    this.connections.delete(normalized);
    void pending.connection
      .then((value) => this.close(value))
      .catch(() => undefined);
  }

  private connection(input: PreviewDevtoolsContext) {
    const scope = requiredValue(input.scope, "scope");
    const worktree = requiredValue(input.worktree, "worktree");
    const current = this.connections.get(scope);
    const value = current?.value;
    if (
      current &&
      (!value ||
        (!value.closed &&
          value.worktree === worktree &&
          value.pageIdentity === input.pageIdentity))
    )
      return current;
    if (current) {
      this.pageState.closed(scope, value?.closed ? "browser" : "replaced");
      void current.connection
        .then((old) => this.close(old))
        .catch(() => undefined);
    }
    const pending: PendingConnection = {
      connection: this.openConnection({ ...input, scope, worktree }),
    };
    this.connections.set(scope, pending);
    void pending.connection.then(
      (connection) => {
        pending.value = connection;
        // The page went away: the next call reconnects.
        void connection.endpoint.closed.then(() => {
          connection.closed = true;
          if (this.connections.get(scope) === pending)
            this.pageState.closed(scope, "browser");
          void this.close(connection);
        });
      },
      () => {
        if (this.connections.get(scope) === pending)
          this.connections.delete(scope);
      },
    );
    return pending;
  }

  private async openConnection(input: PreviewDevtoolsContext) {
    const endpoint = await input.openEndpoint();
    try {
      const artifacts = await mkdtemp(
        join(tmpdir(), "blame-preview-devtools-"),
      );
      const session = agentBrowserSession(input.scope);
      return {
        artifacts,
        closed: false,
        endpoint,
        pageIdentity: input.pageIdentity,
        reconnected: this.pageState.opened(input.scope),
        session,
        workspace: await accessibleWorkspace(input.worktree),
        worktree: input.worktree,
      } satisfies Connection;
    } catch (error) {
      await endpoint.close();
      throw error;
    }
  }

  // Attach the session to the endpoint (some commands, such as read, never
  // do it themselves). After a reconnection, put back the emulation and
  // page the agent had, before its call runs.
  private async restore(connection: Connection, input: PreviewDevtoolsCall) {
    const context = this.toolContext(
      connection,
      input,
      previewDevtoolsToolTimeoutMs("navigate_page"),
    );
    // The daemon starts a screen stream on a loopback port, open to any
    // local process and to pages served from localhost: the agent's page
    // is only reachable through the proxy.
    await context.cli(["stream", "disable"]);
    await context.cli(["get", "url"]);
    if (!connection.reconnected) return;
    connection.notice = await this.pageState.restore(
      input.scope.trim(),
      connection.reconnected,
      {
        emulate: (value) => applyEmulation(value, context),
        navigate: (url) => context.cli(["open", url]),
      },
      {
        origin: input.previewOrigin ?? originOf(input.currentUrl),
        url: connection.endpoint.pageUrl?.(),
      },
    );
  }

  private toolContext(
    connection: Connection,
    input: PreviewDevtoolsCall,
    timeout: number,
  ): PreviewToolContext {
    return {
      cli: (args) => {
        connection.started = true;
        return this.run({
          args,
          endpoint: connection.endpoint.wsEndpoint,
          session: connection.session,
          signal: input.signal,
          timeoutMs: Math.max(timeout - previewDevtoolsTimeoutMarginMs, 1_000),
        });
      },
      previewUrl: (value) => scopedPreviewUrl(input, value),
      screenshot: () => {
        const path = join(
          connection.artifacts,
          `screenshot-${randomUUID()}.png`,
        );
        return {
          path,
          read: async () => {
            try {
              return await readFile(path);
            } finally {
              await rm(path, { force: true });
            }
          },
        };
      },
      uploadPaths: (values) =>
        uploadFilePaths(
          {
            artifacts: connection.artifacts,
            signal: input.signal,
            workspace: connection.workspace,
            worktree: connection.worktree,
          },
          values,
        ),
      viewport: connection.endpoint.viewport ?? defaultViewport,
    };
  }

  // Closing the endpoint drops the session's CDP connection, which ends a
  // stuck command; closing the session then stops its daemon.
  private async close(connection: Connection) {
    if (connection.disposed) return;
    connection.disposed = true;
    connection.closed = true;
    await connection.endpoint.close().catch(() => undefined);
    await Promise.allSettled([
      connection.started &&
        this.run({
          args: ["close"],
          session: connection.session,
          timeoutMs: 5_000,
        }),
      rm(connection.artifacts, { force: true, recursive: true }),
    ]);
  }
}

// The CDP proxy enforces the same rule; checking here gives the agent a
// clear message and lets it pass a path such as "/settings".
export function scopedPreviewUrl(
  input: Pick<PreviewDevtoolsCall, "currentUrl" | "previewOrigin">,
  value: string,
) {
  const origin = input.previewOrigin ?? originOf(input.currentUrl);
  let url: string;
  try {
    url =
      value.trim() === "about:blank"
        ? "about:blank"
        : new URL(value.trim(), input.previewOrigin ?? input.currentUrl).href;
  } catch {
    throw new Error(`navigate_page received an invalid url: ${value}`);
  }
  if (!previewNavigationAllowed(url, origin))
    throw new Error(
      `navigate_page can only open this story's preview (${origin ?? "unknown origin"}) or about:blank. ${url} is outside it.`,
    );
  return url;
}

function lostConnection(error: unknown) {
  return /CDP connection failed|WebSocket|connection (?:closed|refused|reset)/iu.test(
    errorMessage(error),
  );
}

async function accessibleWorkspace(worktree: string) {
  const workspace = runtimeHostPath(worktree);
  return existsSync(workspace) ? realpath(workspace) : undefined;
}

function withNotice(
  result: PreviewToolResult,
  notice: string,
): PreviewToolResult {
  return {
    ...result,
    content: [{ text: notice, type: "text" }, ...result.content],
  };
}

function originOf(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function abortable<T>(value: Promise<T>, signal?: AbortSignal) {
  if (!signal) return value;
  signal.throwIfAborted();
  return new Promise<T>((resolveValue, rejectValue) => {
    const aborted = () => rejectValue(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    value.then(resolveValue, rejectValue).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function requiredValue(value: string, label: string) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Preview DevTools ${label} is required.`);
  return normalized;
}

export const previewDevtoolsService = new PreviewDevtoolsService();

export function shutdownPreviewDevtools() {
  return previewDevtoolsService.dispose();
}
