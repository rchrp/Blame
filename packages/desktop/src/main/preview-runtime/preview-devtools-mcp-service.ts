import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import {
  previewDevtoolsMcpVersion,
  previewDevtoolsServerArgs,
} from "../preview-browser/preview-devtools-config.ts";
import { setupPath } from "../host-tool-path.ts";
import { previewNavigationAllowed } from "../preview-browser/preview-navigation-policy.ts";
import {
  run as runInWorkspace,
  runtimeHostPath,
  runtimeManagedPath,
} from "../workspace-runtime.ts";
import {
  previewDevtoolsBoundedArguments,
  previewDevtoolsToolAllowed,
  previewDevtoolsToolTimeoutMs,
} from "@blame/agent-runtime";
import {
  PreviewDevtoolsPageState,
  type PreviewReconnectReason,
} from "./preview-devtools-page-state.ts";
import toolCatalog from "./preview-devtools-tool-catalog.json" with { type: "json" };

export type PreviewDevtoolsEndpoint = {
  close(): Promise<void>;
  closed: Promise<void>;
  // Where the agent's page is now.
  pageUrl?(): string;
  wsEndpoint: string;
};

export type PreviewDevtoolsMcpContext = {
  // Opens a fresh single-page CDP proxy for this scope. Each MCP connection
  // gets its own port and token, closed with the connection.
  openEndpoint(): Promise<PreviewDevtoolsEndpoint>;
  pageIdentity?: string;
  previewOrigin?: string;
  scope: string;
  signal?: AbortSignal;
  worktree: string;
};

export type PreviewDevtoolsMcpTool = {
  description?: string;
  inputSchema: Record<string, unknown>;
  name: string;
};

export type PreviewDevtoolsMcpCall = PreviewDevtoolsMcpContext & {
  // The project turned on Advanced browser diagnostics.
  advanced?: boolean;
  arguments?: Record<string, unknown>;
  currentUrl: string;
  toolName: string;
};

type McpConnection = {
  artifacts: string;
  client: Client;
  close(): Promise<void>;
  closed: boolean;
  onClosed?: () => void;
  pageUrl?(): string;
  tools: PreviewDevtoolsMcpTool[];
  workspace?: string;
};

type CreateMcpConnection = (
  input: PreviewDevtoolsMcpContext,
) => Promise<McpConnection>;

type PendingConnection = {
  abortController: AbortController;
  closed: boolean;
  connection: Promise<McpConnection>;
  // Told to the agent with the first result after a reconnection.
  notice?: string;
  pageIdentity?: string;
  reconnected?: PreviewReconnectReason;
  restored?: Promise<void>;
  worktree: string;
};

const hiddenPageTools = new Set([
  "close_page",
  "list_pages",
  "new_page",
  "select_page",
]);
const artifactInputPathArguments = new Map<string, readonly string[]>([
  ["close_heapsnapshot", ["filePath"]],
  ["compare_heapsnapshots", ["baseFilePath", "currentFilePath"]],
  ["get_heapsnapshot_class_nodes", ["filePath"]],
  ["get_heapsnapshot_details", ["filePath"]],
  ["get_heapsnapshot_dominators", ["filePath"]],
  ["get_heapsnapshot_duplicate_strings", ["filePath"]],
  ["get_heapsnapshot_edges", ["filePath"]],
  ["get_heapsnapshot_object_details", ["filePath"]],
  ["get_heapsnapshot_retainers", ["filePath"]],
  ["get_heapsnapshot_retaining_paths", ["filePath"]],
  ["get_heapsnapshot_summary", ["filePath"]],
  ["query_heapsnapshot_objects", ["filePath"]],
]);
const artifactOutputPathArguments = new Map<string, readonly string[]>([
  ["evaluate_script", ["filePath"]],
  ["get_network_request", ["requestFilePath", "responseFilePath"]],
  ["lighthouse_audit", ["outputDirPath"]],
  ["performance_start_trace", ["filePath"]],
  ["performance_stop_trace", ["filePath"]],
  ["take_heapsnapshot", ["filePath"]],
  ["take_screenshot", ["filePath"]],
  ["take_snapshot", ["filePath"]],
]);
// The JSON Schema dialect URL is noise to the model: drop it from what is
// sent with every request.
const catalogTools = (toolCatalog.tools as PreviewDevtoolsMcpTool[]).map(
  ({ inputSchema, ...tool }) => {
    const { $schema: _dialect, ...schema } = inputSchema;
    return { ...tool, inputSchema: schema };
  },
);
const catalogToolNames = new Set(catalogTools.map(({ name }) => name));
const maximumStagedUploadBytes = 20 * 1024 * 1024;
const previewMcpCallTimeoutMs = 15_000;
const require = createRequire(import.meta.url);

export class PreviewDevtoolsMcpService {
  private readonly connections = new Map<string, PendingConnection>();
  private readonly createConnection: CreateMcpConnection;
  private readonly pageState = new PreviewDevtoolsPageState();

  constructor(createConnection: CreateMcpConnection = createMcpConnection) {
    this.createConnection = createConnection;
  }

  // The default set keeps the schemas sent with every request small;
  // diagnostics are added when the project asks for them.
  listTools(options: { advanced?: boolean } = {}) {
    return Promise.resolve(
      catalogTools.filter(({ name }) =>
        previewDevtoolsToolAllowed(name, options.advanced === true),
      ),
    );
  }

  async call(input: PreviewDevtoolsMcpCall) {
    input.signal?.throwIfAborted();
    if (!catalogToolNames.has(input.toolName)) {
      throw unavailableToolError(input.toolName);
    }
    if (!previewDevtoolsToolAllowed(input.toolName, input.advanced === true))
      throw new Error(
        `Preview DevTools tool ${input.toolName} is an advanced diagnostic. It is available once Advanced browser diagnostics is turned on for this project in Settings.`,
      );
    const pending = this.connection(input);
    const connection = await waitForConnection(
      pending.connection,
      input.signal,
    );
    const tool = connection.tools.find(({ name }) => name === input.toolName);
    if (!tool || hiddenPageTools.has(tool.name)) {
      throw unavailableToolError(input.toolName);
    }
    const scope = input.scope.trim();
    await waitForConnection(
      (pending.restored ??= this.restore(pending, connection, input)),
      input.signal,
    );
    const notice = pending.notice;
    pending.notice = undefined;
    const argumentsValue = previewDevtoolsBoundedArguments(
      tool.name,
      await previewToolArguments(connection, tool, input),
    );
    const timeout = previewDevtoolsToolTimeoutMs(tool.name, {
      arguments: argumentsValue,
      slowdown: this.pageState.slowdown(scope),
    });
    try {
      const result = await callMcpTool(
        connection.client,
        tool.name,
        argumentsValue,
        input.signal,
        timeout,
      );
      this.pageState.record(
        scope,
        tool.name,
        argumentsValue,
        result,
        connection.pageUrl?.(),
      );
      return notice ? withNotice(result, notice) : result;
    } catch (error) {
      // chrome-devtools-mcp runs one tool at a time and does not stop a
      // tool its client gave up on. A fresh connection frees the browser
      // for the next call instead of queueing it behind the stuck one.
      const reason: PreviewReconnectReason | undefined = input.signal?.aborted
        ? "cancelled"
        : mcpTimedOut(error)
          ? "timeout"
          : mcpConnectionUnavailable(error)
            ? "connection"
            : undefined;
      if (reason) this.disposeScope(scope, reason);
      if (reason === "timeout")
        throw new Error(
          `Preview DevTools ${tool.name} did not finish within ${Math.round(timeout / 1000)} s. The browser connection was reset so the next call starts clean; the page keeps its address and emulation.`,
          { cause: error },
        );
      throw error;
    }
  }

  async dispose() {
    const pending = Array.from(this.connections.values());
    this.connections.clear();
    pending.forEach(({ abortController }) => abortController.abort());
    await Promise.allSettled(
      pending.map(async ({ connection }) => (await connection).close()),
    );
  }

  disposeScope(scope: string, reason: PreviewReconnectReason = "preview") {
    const normalized = scope.trim();
    const pending = this.connections.get(normalized);
    if (!pending) return;
    this.pageState.closed(normalized, reason);
    this.connections.delete(normalized);
    pending.abortController.abort();
    void pending.connection.then(({ close }) => close()).catch(() => undefined);
  }

  private connection(input: PreviewDevtoolsMcpContext) {
    const scope = requiredValue(input.scope, "scope");
    const worktree = requiredValue(input.worktree, "worktree");
    const current = this.connections.get(scope);
    if (
      current &&
      !current.closed &&
      current.worktree === worktree &&
      current.pageIdentity === input.pageIdentity
    )
      return current;
    if (current) {
      this.pageState.closed(scope, current.closed ? "browser" : "replaced");
      current.abortController.abort();
      void current.connection
        .then(({ close }) => close())
        .catch(() => undefined);
    }
    const abortController = new AbortController();
    const connection = this.createConnection({
      ...input,
      scope,
      signal: abortController.signal,
      worktree,
    });
    const pending: PendingConnection = {
      abortController,
      closed: false,
      connection,
      pageIdentity: input.pageIdentity,
      reconnected: this.pageState.opened(scope),
      worktree,
    };
    const ended = () => {
      pending.closed = true;
      if (this.connections.get(scope) === pending)
        this.pageState.closed(scope, "browser");
    };
    void connection.then(
      (value) => {
        value.onClosed = ended;
        if (value.closed) ended();
      },
      () => undefined,
    );
    this.connections.set(scope, pending);
    void connection.catch(() => {
      if (this.connections.get(scope) === pending)
        this.connections.delete(scope);
    });
    return pending;
  }

  // After a reconnection, put back the viewport, emulation and page the
  // agent had, before its call runs.
  private async restore(
    pending: PendingConnection,
    connection: McpConnection,
    input: PreviewDevtoolsMcpCall,
  ) {
    if (!pending.reconnected) return;
    const scope = input.scope.trim();
    pending.notice = await this.pageState.restore(
      scope,
      pending.reconnected,
      (toolName, value) => {
        const argumentsValue = { ...value };
        if (toolName === "navigate_page")
          scopeNavigation(input, argumentsValue);
        return callMcpTool(
          connection.client,
          toolName,
          argumentsValue,
          input.signal,
          previewDevtoolsToolTimeoutMs(toolName, {
            arguments: argumentsValue,
            slowdown: this.pageState.slowdown(scope),
          }),
        );
      },
      {
        origin: input.previewOrigin ?? originOf(input.currentUrl),
        url: connection.pageUrl?.(),
      },
    );
  }
}

function withNotice(result: unknown, notice: string) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return result;
  const value = result as { content?: unknown };
  return {
    ...value,
    content: [
      { type: "text", text: notice },
      ...(Array.isArray(value.content) ? value.content : []),
    ],
  };
}

async function previewToolArguments(
  connection: McpConnection,
  tool: PreviewDevtoolsMcpTool,
  input: PreviewDevtoolsMcpCall,
) {
  const argumentsValue = { ...(input.arguments ?? {}) };
  if (tool.name === "navigate_page") scopeNavigation(input, argumentsValue);
  await scopeArtifactPaths(connection.artifacts, tool.name, argumentsValue);
  if (tool.name !== "upload_file" || !Array.isArray(argumentsValue.filePaths)) {
    return argumentsValue;
  }
  argumentsValue.filePaths = await uploadFilePaths(
    connection,
    input,
    argumentsValue.filePaths,
  );
  return argumentsValue;
}

// The CDP proxy enforces the same rule; checking here gives the agent a
// clear message and lets it pass a path such as "/settings".
export function scopeNavigation(
  input: Pick<PreviewDevtoolsMcpCall, "currentUrl" | "previewOrigin">,
  argumentsValue: Record<string, unknown>,
) {
  const type = argumentsValue.type ?? "url";
  if (type !== "url") return;
  const value = argumentsValue.url;
  if (typeof value !== "string" || !value.trim())
    throw new Error("navigate_page needs a url when type is url.");
  const base = input.previewOrigin ?? input.currentUrl;
  let url: string;
  try {
    url =
      value.trim() === "about:blank"
        ? "about:blank"
        : new URL(value.trim(), base).href;
  } catch {
    throw new Error(`navigate_page received an invalid url: ${value}`);
  }
  if (
    !previewNavigationAllowed(
      url,
      input.previewOrigin ?? originOf(input.currentUrl),
    )
  )
    throw new Error(
      `navigate_page can only open this story's preview (${input.previewOrigin ?? originOf(input.currentUrl) ?? "unknown origin"}) or about:blank. ${url} is outside it.`,
    );
  argumentsValue.url = url;
}

function originOf(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

async function scopeArtifactPaths(
  artifacts: string,
  toolName: string,
  argumentsValue: Record<string, unknown>,
) {
  for (const name of artifactOutputPathArguments.get(toolName) ?? []) {
    if (argumentsValue[name] !== undefined) {
      argumentsValue[name] = scopedArtifactOutputPath(
        artifacts,
        argumentsValue[name],
      );
    }
  }
  for (const name of artifactInputPathArguments.get(toolName) ?? []) {
    argumentsValue[name] = await scopedArtifactInputPath(
      artifacts,
      argumentsValue[name],
    );
  }
}

export function scopedArtifactOutputPath(root: string, value: unknown) {
  const contained = containedPath(root, requiredMcpFilePath(value));
  if (!contained) throw artifactOutsideScopeError();
  return contained;
}

async function scopedArtifactInputPath(root: string, value: unknown) {
  const contained = await resolvedContainedPath(
    root,
    requiredMcpFilePath(value),
  );
  if (!contained) throw artifactOutsideScopeError();
  return contained;
}

async function uploadFilePaths(
  connection: McpConnection,
  input: PreviewDevtoolsMcpCall,
  values: unknown[],
) {
  const paths: string[] = [];
  for (const value of values) {
    const candidate = requiredUploadPath(value);
    const artifact = await absoluteContainedPath(
      connection.artifacts,
      candidate,
    );
    if (artifact) paths.push(artifact);
    else if (connection.workspace) {
      paths.push(
        await accessibleUploadPath(connection.workspace, input, candidate),
      );
    } else {
      paths.push(
        await stageRuntimeUpload(connection.artifacts, input, candidate),
      );
    }
  }
  return paths;
}

async function accessibleUploadPath(
  workspace: string,
  input: PreviewDevtoolsMcpCall,
  candidate: string,
) {
  const contained = await resolvedContainedPath(workspace, candidate);
  if (contained) return contained;
  if (!runtimeManagedPath(input.worktree)) throw uploadOutsideWorkspaceError();
  const relativePath = workspaceUploadRelativePath(input.worktree, candidate);
  const bridgedPath = join(workspace, ...relativePath.split("/"));
  const bridged = await resolvedContainedPath(workspace, bridgedPath);
  if (!bridged) throw uploadOutsideWorkspaceError();
  return bridged;
}

async function stageRuntimeUpload(
  artifacts: string,
  input: PreviewDevtoolsMcpCall,
  candidate: string,
) {
  if (!runtimeManagedPath(input.worktree)) {
    throw new Error("The preview workspace is not accessible from the host.");
  }
  input.signal?.throwIfAborted();
  const source = await runtimeUploadSource(input.worktree, candidate);
  await assertStagedUploadSize(source, input.worktree);
  const { stdout } = await runInWorkspace(
    "base64",
    ["--wrap=0", "--", source],
    { cwd: input.worktree, maxBuffer: maximumStagedUploadBytes * 2 },
  );
  input.signal?.throwIfAborted();
  const destination = join(artifacts, stagedUploadName(source));
  await writeFile(destination, Buffer.from(stdout.trim(), "base64"));
  return destination;
}

async function runtimeUploadSource(worktree: string, candidate: string) {
  const relativePath = workspaceUploadRelativePath(worktree, candidate);
  const source = posix.join(posix.resolve(worktree), relativePath);
  const { stdout } = await runInWorkspace("realpath", ["--", source], {
    cwd: worktree,
  });
  const canonical = stdout.trim();
  workspaceUploadRelativePath(worktree, canonical);
  return canonical;
}

async function assertStagedUploadSize(source: string, worktree: string) {
  const { stdout } = await runInWorkspace("stat", ["-c", "%s", "--", source], {
    cwd: worktree,
  });
  const size = Number(stdout.trim());
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Unable to determine the preview upload size.");
  }
  if (size > maximumStagedUploadBytes) {
    throw new Error("Preview uploads from the runtime are limited to 20 MiB.");
  }
}

export function workspaceUploadRelativePath(
  worktree: string,
  candidate: string,
) {
  const root = posix.resolve(worktree.replaceAll("\\", "/"));
  const normalized = candidate.replaceAll("\\", "/");
  const file = posix.isAbsolute(normalized)
    ? posix.normalize(normalized)
    : posix.resolve(root, normalized);
  const relativePath = posix.relative(root, file);
  if (!relativePath || escapesRoot(relativePath, posix.sep)) {
    throw uploadOutsideWorkspaceError();
  }
  return relativePath;
}

function stagedUploadName(source: string) {
  const name = posix.basename(source).replace(/[^a-zA-Z0-9._-]/gu, "_");
  return `${randomUUID()}-${name.slice(0, 120) || "upload"}`;
}

function requiredUploadPath(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 8_192) {
    throw new Error("Preview upload path is invalid.");
  }
  return value.trim();
}

function requiredMcpFilePath(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 8_192) {
    throw new Error("Preview DevTools file path is invalid.");
  }
  return value.trim();
}

async function absoluteContainedPath(root: string, candidate: string) {
  return isAbsolute(candidate)
    ? resolvedContainedPath(root, candidate)
    : undefined;
}

async function resolvedContainedPath(root: string, candidate: string) {
  const contained = containedPath(root, candidate);
  if (!contained) return undefined;
  const canonical = await realpath(contained);
  return containedPath(root, canonical);
}

function containedPath(root: string, candidate: string) {
  const file = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(root, candidate);
  const relativePath = relative(root, file);
  return !relativePath || escapesRoot(relativePath, sep) ? undefined : file;
}

function escapesRoot(relativePath: string, separator: string) {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${separator}`) ||
    isAbsolute(relativePath)
  );
}

function uploadOutsideWorkspaceError() {
  return new Error("Preview uploads must stay inside the workspace.");
}

function artifactOutsideScopeError() {
  return new Error("Preview DevTools artifacts must stay inside their scope.");
}

function unavailableToolError(toolName: string) {
  return new Error(`Preview DevTools tool is unavailable: ${toolName}`);
}

async function createMcpConnection(input: PreviewDevtoolsMcpContext) {
  const endpoint = await input.openEndpoint();
  const artifacts = await mkdtemp(join(tmpdir(), "blame-preview-devtools-"));
  const workspace = await accessibleWorkspace(input.worktree);
  const client = previewMcpClient(workspace, artifacts);
  const transport = previewMcpTransport(endpoint.wsEndpoint, artifacts);
  try {
    await client.connect(transport, {
      signal: input.signal,
      timeout: previewMcpCallTimeoutMs,
    });
    const tools = (
      await client.listTools(
        {},
        { signal: input.signal, timeout: previewMcpCallTimeoutMs },
      )
    ).tools;
    const connection: McpConnection = {
      artifacts,
      client,
      close: () => closeMcpConnection(client, artifacts, endpoint),
      closed: false,
      ...(endpoint.pageUrl ? { pageUrl: endpoint.pageUrl } : {}),
      tools: tools.filter(exposedTool),
      ...(workspace ? { workspace } : {}),
    };
    // The proxy closes when its page goes away; the next call reconnects.
    void endpoint.closed.then(() => {
      connection.closed = true;
      connection.onClosed?.();
      void connection.close();
    });
    return connection;
  } catch (error) {
    await closeMcpConnection(client, artifacts, endpoint);
    throw error;
  }
}

function previewMcpTransport(wsEndpoint: string, artifacts: string) {
  const executable = previewDevtoolsExecutable();
  return new StdioClientTransport({
    args: ["-e", previewDevtoolsLoader(executable)],
    command: process.execPath,
    cwd: artifacts,
    env: { ...previewMcpEnvironment(), [endpointVariable]: wsEndpoint },
    stderr: "ignore",
  });
}

// The endpoint carries the proxy token. Passing it through the environment
// keeps it out of the process list, where any local user could read it.
const endpointVariable = "BLAME_PREVIEW_CDP_ENDPOINT";

export function previewDevtoolsLoader(executable: string) {
  const args = JSON.stringify(previewDevtoolsServerArgs());
  return [
    `const endpoint = process.env.${endpointVariable} ?? "";`,
    `delete process.env.${endpointVariable};`,
    `process.argv = [process.argv[0], ${JSON.stringify(executable)}, ...${args}, "--wsEndpoint=" + endpoint];`,
    `import(require("node:url").pathToFileURL(${JSON.stringify(executable)}).href);`,
  ].join("\n");
}

function previewMcpClient(workspace: string | undefined, artifacts: string) {
  const client = new Client(
    { name: "blame-preview", version: previewDevtoolsMcpVersion },
    { capabilities: { roots: { listChanged: false } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, () => ({
    roots: [
      ...(workspace
        ? [{ name: "workspace", uri: pathToFileURL(workspace).href }]
        : []),
      { name: "preview-artifacts", uri: pathToFileURL(artifacts).href },
    ],
  }));
  return client;
}

async function accessibleWorkspace(worktree: string) {
  const workspace = runtimeHostPath(worktree);
  return existsSync(workspace) ? realpath(workspace) : undefined;
}

async function closeMcpConnection(
  client: Client,
  artifacts: string,
  endpoint: PreviewDevtoolsEndpoint,
) {
  await Promise.allSettled([
    Promise.resolve().then(() => client.close()),
    rm(artifacts, { force: true, recursive: true }),
    endpoint.close(),
  ]);
}

function previewMcpEnvironment() {
  return Object.fromEntries(
    Object.entries({
      ...process.env,
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
      ELECTRON_RUN_AS_NODE: "1",
      PATH: setupPath(),
    }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function previewDevtoolsExecutable() {
  const packagePath = require.resolve("chrome-devtools-mcp/package.json");
  return join(
    dirname(packagePath),
    "build",
    "src",
    "bin",
    "chrome-devtools-mcp.js",
  );
}

function exposedTool(tool: PreviewDevtoolsMcpTool) {
  return !hiddenPageTools.has(tool.name);
}

async function callMcpTool(
  client: Client,
  name: string,
  argumentsValue: Record<string, unknown>,
  signal?: AbortSignal,
  timeout = previewMcpCallTimeoutMs,
) {
  try {
    return await client.callTool(
      { arguments: argumentsValue, name },
      undefined,
      { signal, timeout },
    );
  } catch (error) {
    throw new Error(`Preview DevTools ${name} failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function mcpConnectionUnavailable(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (
      /(?:connection|transport|channel) (?:closed|disconnected)|not connected|server (?:closed|disconnected|terminated)/iu.test(
        current.message,
      )
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function mcpTimedOut(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    // The MCP SDK's RequestTimeout error code.
    if ((current as { code?: unknown }).code === -32001) return true;
    if (/request timed out/iu.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

function waitForConnection<T>(value: Promise<T>, signal?: AbortSignal) {
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

function requiredValue(value: string, label: string) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Preview DevTools ${label} is required.`);
  return normalized;
}

export const previewDevtoolsMcpService = new PreviewDevtoolsMcpService();

export function shutdownPreviewDevtoolsMcp() {
  return previewDevtoolsMcpService.dispose();
}
