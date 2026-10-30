import type {
  CodeGraphArchitectureOverviewInput,
  CodeGraphImpactRadiusInput,
  CodeGraphMinimalContextInput,
  CodeGraphQueryResult,
  CodeGraphReviewContextInput,
  CodeGraphStatus,
  CodeGraphUpdateInput,
  CodeGraphUpdateResult,
  CodeReviewGraphProvider,
} from "@blame/agent-runtime";
import { withoutTelemetryEnvironment } from "@blame/telemetry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setupPath } from "./host-tool-path.ts";
import {
  joinWorkspacePath,
  pathExists as runtimePathExists,
  resolveWorkspacePath as resolveRuntimePath,
  runtimeCommand,
  runtimeExecutableCommand,
} from "./workspace-runtime.ts";

type CommandResult = {
  stderr: string;
  stdout: string;
};

type CommandSpec = {
  args: string[];
  command: string;
  source: "env" | "path" | "uvx";
};

type GraphSnapshot = {
  branch: string;
  dirty: boolean;
  fingerprint: string;
  head: string;
};

type ParsedStatus = {
  branch?: string;
  builtCommit?: string;
  edges?: number;
  files?: number;
  languages?: string[];
  lastUpdated?: string;
  nodes?: number;
};

type Availability = {
  available: boolean;
  checkedAt: number;
  command: string;
  message?: string;
  version?: string;
};

type WorkspaceCommandState = {
  args: string[];
  child: ChildProcessWithoutNullStreams;
  cleanup(): void;
  command: string;
  reject(error: Error): void;
  resolve(result: CommandResult): void;
  stderr: Buffer[];
  stdout: Buffer[];
  timer?: NodeJS.Timeout;
};

type GraphMcpClient = {
  callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
};

type CodeReviewGraphServiceInput = {
  availabilityTtlMs?: number;
  command?: () => CommandSpec;
  createMcpClient?: (worktree: string) => GraphMcpClient;
  graphPathExists?: (worktree: string) => Promise<boolean>;
  now?: () => number;
  run?: (
    args: string[],
    worktree: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<CommandResult>;
  snapshot?: (worktree: string) => Promise<GraphSnapshot>;
};

type CodeReviewGraphRunner = NonNullable<CodeReviewGraphServiceInput["run"]>;

const availabilityTimeoutMs = 5_000;
const statusTimeoutMs = 10_000;
const queryTimeoutMs = 20_000;
const updateTimeoutMs = 120_000;
const defaultWaitMs = 10_000;
const defaultUpdateWaitMs = 30_000;
const availabilityTtlMs = 30_000;
const forceKillDelayMs = 1_500;
const mcpTools = [
  "get_minimal_context_tool",
  "get_impact_radius_tool",
  "get_review_context_tool",
  "get_architecture_overview_tool",
  "list_graph_stats_tool",
];

export class CodeReviewGraphService {
  private readonly availability = new Map<string, Availability>();
  private readonly command: () => CommandSpec;
  private readonly createMcpClient: (worktree: string) => GraphMcpClient;
  private readonly graphPathExists: (worktree: string) => Promise<boolean>;
  private readonly mcpClients = new Map<string, GraphMcpClient>();
  private readonly now: () => number;
  private readonly run: CodeReviewGraphRunner;
  private readonly snapshotReader: (worktree: string) => Promise<GraphSnapshot>;
  private readonly snapshots = new Map<string, string>();
  private readonly updates = new Map<string, Promise<CodeGraphUpdateResult>>();
  private readonly availabilityTtlMs: number;

  constructor(input: CodeReviewGraphServiceInput = {}) {
    this.availabilityTtlMs = input.availabilityTtlMs ?? availabilityTtlMs;
    this.command = input.command ?? (() => resolveCodeReviewGraphCommand());
    this.createMcpClient =
      input.createMcpClient ??
      ((worktree) => new CodeReviewGraphMcpClient(worktree, this.command()));
    this.graphPathExists = input.graphPathExists ?? graphDbExists;
    this.now = input.now ?? Date.now;
    this.run = input.run ?? runCodeReviewGraphCommand;
    this.snapshotReader = input.snapshot ?? readGitSnapshot;
  }

  async status(input: {
    signal?: AbortSignal;
    worktree: string;
  }): Promise<CodeGraphStatus> {
    const worktree = resolveRuntimePath(input.worktree);
    if (this.updates.has(worktree)) return this.buildingStatus(worktree);
    return this.statusWithoutBuilding(worktree, input.signal);
  }

  async update(input: CodeGraphUpdateInput): Promise<CodeGraphUpdateResult> {
    const worktree = resolveRuntimePath(input.worktree);
    const existing = this.updates.get(worktree);
    if (existing) return this.waitForUpdate(worktree, existing, input.waitMs);
    const status = await this.statusWithoutBuilding(worktree, input.signal);
    if (!status.available) return { ...status, action: "unavailable" };
    if (status.state === "ready" && !input.force)
      return { ...status, action: "skipped" };
    return this.startUpdate(worktree, input.force, input.waitMs, input.signal);
  }

  async impactRadius(
    input: CodeGraphImpactRadiusInput,
  ): Promise<CodeGraphQueryResult> {
    const status = await this.ensureReady(input);
    if (status.state !== "ready") return status;
    return this.mcpQuery(
      status,
      "get_impact_radius_tool",
      impactRadiusArgs(input),
      input.signal,
    );
  }

  async minimalContext(
    input: CodeGraphMinimalContextInput,
  ): Promise<CodeGraphQueryResult> {
    const status = await this.ensureReady(input);
    if (status.state !== "ready") return status;
    return this.mcpQuery(
      status,
      "get_minimal_context_tool",
      minimalContextArgs(input),
      input.signal,
    );
  }

  async reviewContext(
    input: CodeGraphReviewContextInput,
  ): Promise<CodeGraphQueryResult> {
    const status = await this.ensureReady(input);
    if (status.state !== "ready") return status;
    return this.mcpQuery(
      status,
      "get_review_context_tool",
      reviewContextArgs(input),
      input.signal,
    );
  }

  async architectureOverview(
    input: CodeGraphArchitectureOverviewInput,
  ): Promise<CodeGraphQueryResult> {
    const status = await this.ensureReady(input);
    if (status.state !== "ready") return status;
    return this.mcpQuery(
      status,
      "get_architecture_overview_tool",
      {
        detail_level: input.detailLevel ?? "minimal",
        repo_root: status.worktree,
      },
      input.signal,
    );
  }

  async cleanup(worktreeInput: string) {
    const worktree = resolveRuntimePath(worktreeInput);
    this.availability.delete(worktree);
    this.snapshots.delete(worktree);
    await this.closeMcpClient(worktree);
  }

  async shutdown() {
    await Promise.all(
      Array.from(this.mcpClients.keys()).map((worktree) =>
        this.cleanup(worktree),
      ),
    );
  }

  private async statusWithoutBuilding(
    worktree: string,
    signal?: AbortSignal,
  ): Promise<CodeGraphStatus> {
    const availability = await this.detectAvailability(worktree, signal);
    if (!availability.available) return missingStatus(worktree, availability);
    if (!(await this.graphPathExists(worktree)))
      return missingStatus(worktree, availability);
    return this.statusFromCli(worktree, availability, signal);
  }

  private async statusFromCli(
    worktree: string,
    availability: Availability,
    signal?: AbortSignal,
  ) {
    try {
      const output = await this.run(
        ["status", "--repo", worktree],
        worktree,
        statusTimeoutMs,
        signal,
      );
      const parsed = parseCodeReviewGraphStatus(output.stdout);
      if (!parsed.lastUpdated || parsed.lastUpdated === "never")
        return missingStatus(worktree, availability);
      return await this.freshStatus(worktree, availability, parsed);
    } catch (error) {
      return errorStatus(worktree, availability, error);
    }
  }

  private async freshStatus(
    worktree: string,
    availability: Availability,
    parsed: ParsedStatus,
  ): Promise<CodeGraphStatus> {
    const snapshot = await this.snapshotReader(worktree);
    const reason = staleReason(parsed, snapshot, this.snapshots.get(worktree));
    return {
      ...baseStatus(worktree, availability, parsed),
      ...(reason ? { staleReason: reason } : {}),
      recommendation: reason
        ? "Call update_code_graph before relying on code graph context."
        : "Use code graph tools before broad file reads.",
      state: reason ? "stale" : "ready",
    };
  }

  private async detectAvailability(
    worktree: string,
    signal?: AbortSignal,
  ): Promise<Availability> {
    const cached = this.availability.get(worktree);
    if (cached && this.now() - cached.checkedAt < this.availabilityTtlMs)
      return cached;
    const result = await this.loadAvailability(worktree, signal);
    this.availability.set(worktree, result);
    return result;
  }

  private async loadAvailability(worktree: string, signal?: AbortSignal) {
    const command = commandLabel(this.command());
    try {
      const output = await this.run(
        ["--version"],
        worktree,
        availabilityTimeoutMs,
        signal,
      );
      return {
        available: true,
        checkedAt: this.now(),
        command,
        version: versionFromOutput(output.stdout),
      };
    } catch (error) {
      return {
        available: false,
        checkedAt: this.now(),
        command,
        message: missingCommand(error)
          ? "code-review-graph command not found"
          : errorMessage(error),
      };
    }
  }

  private startUpdate(
    worktree: string,
    force: boolean | undefined,
    waitMs: number | undefined,
    signal?: AbortSignal,
  ) {
    const promise = this.runUpdate(worktree, force, signal);
    this.updates.set(worktree, promise);
    void promise
      .finally(() => {
        if (this.updates.get(worktree) === promise)
          this.updates.delete(worktree);
      })
      .catch(() => undefined);
    return this.waitForUpdate(worktree, promise, waitMs);
  }

  private async waitForUpdate(
    worktree: string,
    promise: Promise<CodeGraphUpdateResult>,
    waitMs = defaultUpdateWaitMs,
  ) {
    const result = await timeoutValue(promise, waitMs);
    if (result) return result;
    return {
      ...(await this.buildingStatus(worktree)),
      action: "building" as const,
    };
  }

  private async runUpdate(
    worktree: string,
    force: boolean | undefined,
    signal?: AbortSignal,
  ): Promise<CodeGraphUpdateResult> {
    const startedAt = this.now();
    try {
      const graphExists = await this.graphPathExists(worktree);
      const action = graphExists && !force ? "update" : "build";
      const output = await this.runUpdateCommand(worktree, action, signal);
      await this.rememberSnapshot(worktree);
      return {
        ...(await this.statusWithoutBuilding(worktree, signal)),
        action: "updated",
        durationMs: this.now() - startedAt,
        output,
      };
    } catch (error) {
      return failedUpdateStatus(worktree, this.command(), error);
    }
  }

  private async runUpdateCommand(
    worktree: string,
    action: "build" | "update",
    signal?: AbortSignal,
  ) {
    const output = await this.run(
      [action, "--repo", worktree],
      worktree,
      updateTimeoutMs,
      signal,
    );
    if (action === "build")
      await this.run(
        ["postprocess", "--repo", worktree],
        worktree,
        updateTimeoutMs,
        signal,
      );
    return compactCommandOutput(output);
  }

  private async ensureReady(
    input:
      | CodeGraphImpactRadiusInput
      | CodeGraphMinimalContextInput
      | CodeGraphReviewContextInput
      | CodeGraphArchitectureOverviewInput,
  ) {
    const status = await this.status({
      signal: input.signal,
      worktree: input.worktree,
    });
    if (status.state === "ready") return status;
    if (!["missing", "stale", "building"].includes(status.state)) return status;
    return this.update({
      signal: input.signal,
      waitMs: input.waitMs ?? defaultWaitMs,
      worktree: input.worktree,
    });
  }

  private async mcpQuery(
    status: CodeGraphStatus,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CodeGraphQueryResult> {
    try {
      const client = this.mcpClient(status.worktree);
      const result = await client.callTool(tool, args, queryTimeoutMs, signal);
      return {
        ...status,
        data: compactGraphPayload(parseMcpToolResult(result)),
        source: "mcp",
      };
    } catch (error) {
      await this.closeMcpClient(status.worktree);
      return this.cliFallback(status, error, signal);
    }
  }

  private async cliFallback(
    status: CodeGraphStatus,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<CodeGraphQueryResult> {
    try {
      const output = await this.run(
        ["detect-changes", "--repo", status.worktree],
        status.worktree,
        queryTimeoutMs,
        signal,
      );
      return {
        ...status,
        data: {
          ...asFallbackObject(parseDetectChangesOutput(output.stdout)),
          mcpError: errorMessage(error),
        },
        source: "cli",
      };
    } catch {
      return {
        ...status,
        message: errorMessage(error),
        recommendation:
          "Call update_code_graph, then retry the code graph query.",
        state: "error",
      };
    }
  }

  private mcpClient(worktree: string) {
    const current = this.mcpClients.get(worktree);
    if (current) return current;
    const next = this.createMcpClient(worktree);
    this.mcpClients.set(worktree, next);
    return next;
  }

  private async closeMcpClient(worktree: string) {
    const client = this.mcpClients.get(worktree);
    if (!client) return;
    this.mcpClients.delete(worktree);
    await client.close();
  }

  private async rememberSnapshot(worktree: string) {
    this.snapshots.set(
      worktree,
      (await this.snapshotReader(worktree)).fingerprint,
    );
  }

  private async buildingStatus(worktree: string): Promise<CodeGraphStatus> {
    const availability = await this.detectAvailability(worktree);
    return {
      available: availability.available,
      command: availability.command,
      message: "Code graph update is running.",
      recommendation: "Wait briefly or call get_code_graph_status again.",
      state: "building",
      version: availability.version,
      worktree,
    };
  }
}

const codeReviewGraph = new CodeReviewGraphService();

export const codeReviewGraphProvider: CodeReviewGraphProvider = {
  architectureOverview: (input) => codeReviewGraph.architectureOverview(input),
  impactRadius: (input) => codeReviewGraph.impactRadius(input),
  minimalContext: (input) => codeReviewGraph.minimalContext(input),
  reviewContext: (input) => codeReviewGraph.reviewContext(input),
  status: (input) => codeReviewGraph.status(input),
  update: (input) => codeReviewGraph.update(input),
};

export function shutdownCodeReviewGraph() {
  return codeReviewGraph.shutdown();
}

export function cleanupCodeReviewGraphWorktree(worktree: string) {
  return codeReviewGraph.cleanup(worktree);
}

class CodeReviewGraphMcpClient implements GraphMcpClient {
  private client?: Client;
  private connected?: Promise<void>;
  private transport?: StdioClientTransport;
  private readonly worktree: string;
  private readonly command: CommandSpec;

  constructor(worktree: string, command: CommandSpec) {
    this.worktree = worktree;
    this.command = command;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    await this.connect(signal);
    const result = await this.client!.callTool(
      { arguments: args, name },
      CallToolResultSchema,
      { signal, timeout: timeoutMs },
    );
    if (!("content" in result) || !Array.isArray(result.content))
      throw new Error("MCP tool returned an unsupported task result");
    return result as CallToolResult;
  }

  async close() {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connected = undefined;
    if (client) {
      await client.close();
    } else if (transport) {
      await transport.close();
    }
  }

  private connect(signal?: AbortSignal) {
    if (this.connected) return this.connected;
    this.connected = this.open(signal).catch((error) => {
      this.connected = undefined;
      this.client = undefined;
      this.transport = undefined;
      throw error;
    });
    return this.connected;
  }

  private async open(signal?: AbortSignal) {
    const args = [
      ...this.command.args,
      ...codeReviewGraphMcpArgs(this.worktree),
    ];
    const spec = runtimeCommand(this.command.command, args, {
      cwd: this.worktree,
    });
    const executable = runtimeExecutableCommand(
      spec,
      process.platform,
      commandEnvironment(),
    );
    const transport = new StdioClientTransport({
      args: executable.args,
      command: executable.command,
      cwd: spec.cwd,
      env: commandEnvironment(),
      stderr: "pipe",
    });
    const client = new Client(
      { name: "blame", version: "0.0.0" },
      { capabilities: {} },
    );
    this.transport = transport;
    this.client = client;
    try {
      await client.connect(transport, { signal, timeout: queryTimeoutMs });
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }
}

export function codeReviewGraphMcpArgs(worktree: string) {
  return ["serve", "--repo", worktree, "--tools", mcpTools.join(",")];
}

export function resolveCodeReviewGraphCommand(
  env: NodeJS.ProcessEnv = process.env,
): CommandSpec {
  const override = env.BLAME_CODE_REVIEW_GRAPH_COMMAND?.trim();
  if (override) {
    return {
      args: commandArgsFromEnv(env),
      command: override,
      source: "env",
    };
  }
  if (env.BLAME_CODE_REVIEW_GRAPH_USE_UVX === "1") {
    return {
      args: ["code-review-graph"],
      command: "uvx",
      source: "uvx",
    };
  }
  return {
    args: [],
    command: "code-review-graph",
    source: "path",
  };
}

export function parseCodeReviewGraphStatus(output: string): ParsedStatus {
  return {
    branch: lineValue(output, "Built on branch"),
    builtCommit: lineValue(output, "Built at commit"),
    edges: numberLineValue(output, "Edges"),
    files: numberLineValue(output, "Files"),
    languages: languagesValue(lineValue(output, "Languages")),
    lastUpdated: lineValue(output, "Last updated"),
    nodes: numberLineValue(output, "Nodes"),
  };
}

export function parseDetectChangesOutput(output: string) {
  return compactGraphPayload(parseJson(output));
}

async function runCodeReviewGraphCommand(
  args: string[],
  worktree: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const command = resolveCodeReviewGraphCommand();
  return runWorkspaceCommand(
    command.command,
    [...command.args, ...args],
    worktree,
    timeoutMs,
    signal,
  );
}

async function gitOutput(worktree: string, args: string[]) {
  const output = await runWorkspaceCommand(
    "git",
    args,
    worktree,
    statusTimeoutMs,
  );
  return output.stdout.trim();
}

async function readGitSnapshot(worktree: string) {
  const [head, branch, status] = await Promise.all([
    gitOutput(worktree, ["rev-parse", "HEAD"]),
    gitOutput(worktree, ["branch", "--show-current"]),
    gitOutput(worktree, ["status", "--porcelain=v1"]),
  ]);
  return {
    branch,
    dirty: Boolean(status.trim()),
    fingerprint: JSON.stringify({ branch, head, status }),
    head,
  };
}

function runWorkspaceCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted)
    return Promise.reject(new Error("Code graph request aborted"));
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnWorkspaceCommand(command, args, cwd);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<CommandResult>((resolve, reject) => {
    const state = workspaceCommandState(command, args, child, resolve, reject);
    state.timer = workspaceCommandTimer(state, timeoutMs);
    state.cleanup = addAbortHandler(signal, () => abortWorkspaceCommand(state));
    bindWorkspaceCommand(state);
  });
}

function workspaceCommandState(
  command: string,
  args: string[],
  child: ChildProcessWithoutNullStreams,
  resolve: (result: CommandResult) => void,
  reject: (error: Error) => void,
): WorkspaceCommandState {
  return {
    args,
    child,
    cleanup: () => undefined,
    command,
    reject,
    resolve,
    stderr: [],
    stdout: [],
  };
}

function workspaceCommandTimer(
  state: WorkspaceCommandState,
  timeoutMs: number,
) {
  const timer = setTimeout(() => timeoutWorkspaceCommand(state), timeoutMs);
  timer.unref();
  return timer;
}

function bindWorkspaceCommand(state: WorkspaceCommandState) {
  state.child.stdout.on("data", (data: Buffer) => state.stdout.push(data));
  state.child.stderr.on("data", (data: Buffer) => state.stderr.push(data));
  state.child.once("error", (error) => rejectWorkspaceCommand(state, error));
  state.child.once("exit", (code) => exitWorkspaceCommand(state, code));
  state.child.stdin.end();
}

function timeoutWorkspaceCommand(state: WorkspaceCommandState) {
  finishWorkspaceCommand(state);
  killChild(state.child);
  state.reject(
    commandError(
      state.command,
      state.args,
      state.stdout,
      state.stderr,
      null,
      true,
    ),
  );
}

function abortWorkspaceCommand(state: WorkspaceCommandState) {
  finishWorkspaceCommand(state);
  killChild(state.child);
  state.reject(new Error("Code graph request aborted"));
}

function rejectWorkspaceCommand(state: WorkspaceCommandState, error: Error) {
  finishWorkspaceCommand(state);
  state.reject(error);
}

function exitWorkspaceCommand(
  state: WorkspaceCommandState,
  code: number | null,
) {
  finishWorkspaceCommand(state);
  if (code === 0) {
    state.resolve(commandResult(state.stdout, state.stderr));
    return;
  }
  state.reject(
    commandError(
      state.command,
      state.args,
      state.stdout,
      state.stderr,
      code,
      false,
    ),
  );
}

function finishWorkspaceCommand(state: WorkspaceCommandState) {
  if (state.timer) clearTimeout(state.timer);
  state.cleanup();
}

function commandResult(stdout: Buffer[], stderr: Buffer[]) {
  return {
    stderr: Buffer.concat(stderr).toString(),
    stdout: Buffer.concat(stdout).toString(),
  };
}

function spawnWorkspaceCommand(command: string, args: string[], cwd: string) {
  const env = commandEnvironment();
  const spec = runtimeCommand(command, args, { cwd });
  const executable = runtimeExecutableCommand(spec, process.platform, env);
  return spawn(executable.command, executable.args, {
    cwd: spec.cwd,
    env,
    shell: false,
    windowsVerbatimArguments: executable.windowsVerbatimArguments,
  });
}

function commandEnvironment() {
  return {
    ...withoutTelemetryEnvironment(process.env),
    PATH: setupPath(),
    PYTHONUTF8: "1",
  };
}

function graphDbExists(worktree: string) {
  return runtimePathExists(
    joinWorkspacePath(worktree, ".code-review-graph", "graph.db"),
  );
}

function missingStatus(
  worktree: string,
  availability: Availability,
): CodeGraphStatus {
  return {
    available: availability.available,
    command: availability.command,
    message: availability.message,
    recommendation: availability.available
      ? "Call update_code_graph to build the local code graph."
      : "Install code-review-graph on PATH or set BLAME_CODE_REVIEW_GRAPH_COMMAND.",
    state: "missing",
    version: availability.version,
    worktree,
  };
}

function errorStatus(
  worktree: string,
  availability: Availability,
  error: unknown,
): CodeGraphStatus {
  return {
    available: availability.available,
    command: availability.command,
    message: errorMessage(error),
    recommendation: "Call update_code_graph, then retry the code graph query.",
    state: "error",
    version: availability.version,
    worktree,
  };
}

function failedUpdateStatus(
  worktree: string,
  command: CommandSpec,
  error: unknown,
): CodeGraphUpdateResult {
  return {
    action: "failed",
    available: !missingCommand(error),
    command: commandLabel(command),
    message: errorMessage(error),
    recommendation: missingCommand(error)
      ? "Install code-review-graph on PATH or set BLAME_CODE_REVIEW_GRAPH_COMMAND."
      : "Retry update_code_graph after addressing the reported code-review-graph error.",
    state: missingCommand(error) ? "missing" : "error",
    worktree,
  };
}

function baseStatus(
  worktree: string,
  availability: Availability,
  parsed: ParsedStatus,
): CodeGraphStatus {
  return {
    available: true,
    branch: parsed.branch,
    builtCommit: parsed.builtCommit,
    command: availability.command,
    edges: parsed.edges,
    files: parsed.files,
    languages: parsed.languages,
    lastUpdated: parsed.lastUpdated,
    nodes: parsed.nodes,
    state: "ready",
    version: availability.version,
    worktree,
  };
}

function staleReason(
  parsed: ParsedStatus,
  snapshot: GraphSnapshot,
  cached?: string,
) {
  if (parsed.builtCommit && !sameGitCommit(parsed.builtCommit, snapshot.head))
    return "Graph was built for a different commit.";
  if (snapshot.dirty && cached !== snapshot.fingerprint)
    return "Worktree has changes not reflected in this Blame session graph cache.";
  return undefined;
}

function sameGitCommit(left: string, right: string) {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function minimalContextArgs(input: CodeGraphMinimalContextInput) {
  return {
    ...queryArgs(input),
    ...(input.task ? { task: truncate(input.task, 300) } : {}),
  };
}

function impactRadiusArgs(input: CodeGraphImpactRadiusInput) {
  return {
    ...queryArgs(input),
    detail_level: "minimal",
    max_depth: input.maxDepth ?? 2,
  };
}

function reviewContextArgs(input: CodeGraphReviewContextInput) {
  return {
    ...impactRadiusArgs(input),
    include_source: input.includeSource ?? false,
    max_lines_per_file: input.maxLinesPerFile ?? 120,
  };
}

function queryArgs(
  input:
    | CodeGraphImpactRadiusInput
    | CodeGraphMinimalContextInput
    | CodeGraphReviewContextInput,
) {
  return {
    ...(safeGitRef(input.base) ? { base: safeGitRef(input.base) } : {}),
    ...(safeChangedFiles(input.changedFiles)
      ? { changed_files: safeChangedFiles(input.changedFiles) }
      : {}),
    repo_root: resolveRuntimePath(input.worktree),
  };
}

function safeGitRef(value: string | undefined) {
  if (!value) return undefined;
  return /^[A-Za-z0-9._/@:-]{1,160}$/.test(value) ? value : undefined;
}

function safeChangedFiles(value: string[] | undefined) {
  const files = value?.filter(safeRelativePath).slice(0, 100);
  return files?.length ? files : undefined;
}

function safeRelativePath(value: string) {
  if (!value || value.includes("\0")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]+/).includes("..");
}

function compactGraphPayload(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return compactRecord(value);
}

function compactRecord(value: Record<string, unknown>) {
  return definedEntries({
    status: value.status,
    summary: value.summary,
    risk: value.risk ?? value.risk_score,
    changedFileCount: value.changed_file_count,
    impactedFileCount: value.impacted_file_count,
    keyEntities: limitStrings(value.key_entities, 12),
    testGaps: compactArray(value.test_gaps, 12),
    changedFunctions: compactArray(value.changed_functions, 12),
    reviewPriorities: compactArray(value.review_priorities, 12),
    affectedFlows: compactArray(value.affected_flows, 8),
    communities: compactArray(value.communities, 12),
    crossCommunityEdges: compactArray(value.cross_community_edges, 12),
    warnings: compactArray(value.warnings, 8),
    contextSavings: value.context_savings,
    truncated: value.truncated ?? value.functions_truncated,
    nextToolSuggestions: limitStrings(value.next_tool_suggestions, 8),
  });
}

function compactArray(value: unknown, limit: number) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, limit).map(compactItem);
}

function compactItem(value: unknown) {
  if (!isRecord(value)) return value;
  return definedEntries({
    name: value.name,
    qualifiedName: value.qualified_name,
    file: value.file ?? value.file_path,
    lineStart: value.line_start,
    lineEnd: value.line_end,
    risk: value.risk ?? value.risk_score,
    kind: value.kind,
    language: value.language,
    id: value.id,
    size: value.size,
    cohesion: value.cohesion,
    dominantLanguage: value.dominant_language,
  });
}

function limitStrings(value: unknown, limit: number) {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, limit);
}

function parseMcpToolResult(value: CallToolResult) {
  if (value.structuredContent) return value.structuredContent;
  const text = value.content.find(
    (item): item is Extract<typeof item, { type: "text" }> =>
      item.type === "text",
  )?.text;
  if (!text) return value;
  return parseJson(text) ?? { text: truncate(text, 4_000) };
}

function asFallbackObject(value: unknown) {
  return isRecord(value) ? value : { value };
}

function parseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function commandArgsFromEnv(env: NodeJS.ProcessEnv) {
  const raw = env.BLAME_CODE_REVIEW_GRAPH_ARGS;
  if (!raw) return [];
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function commandLabel(command: CommandSpec) {
  return [command.command, ...command.args].join(" ");
}

function versionFromOutput(stdout: string) {
  return stdout.trim().replace(/^code-review-graph\s*/, "") || undefined;
}

function lineValue(output: string, label: string) {
  const match = output.match(
    new RegExp(`^${escapeRegExp(label)}:\\s*(.*)$`, "m"),
  );
  return match?.[1]?.trim() || undefined;
}

function numberLineValue(output: string, label: string) {
  const value = Number(lineValue(output, label));
  return Number.isFinite(value) ? value : undefined;
}

function languagesValue(value: string | undefined) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactCommandOutput(output: CommandResult) {
  return truncate(
    [output.stdout, output.stderr].filter(Boolean).join("\n").trim(),
    2_000,
  );
}

function commandError(
  command: string,
  args: string[],
  stdout: Buffer[],
  stderr: Buffer[],
  code: number | null,
  timedOut: boolean,
) {
  const output = {
    stderr: Buffer.concat(stderr).toString(),
    stdout: Buffer.concat(stdout).toString(),
  };
  const message = timedOut
    ? `${command} timed out`
    : `${[command, ...args].join(" ")} exited with code ${code ?? ""}`;
  const error = new Error(
    [message, output.stdout, output.stderr].filter(Boolean).join("\n"),
  );
  return Object.assign(error, { code, timedOut, ...output });
}

function missingCommand(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return (
    (isRecord(error) && error.code === "ENOENT") ||
    message.includes("not found") ||
    message.includes("no such file or directory")
  );
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) {
    const message = error.message;
    return typeof message === "string" ? message : JSON.stringify(error);
  }
  return String(error);
}

function definedEntries<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function timeoutValue<T>(promise: Promise<T>, waitMs: number) {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), waitMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function addAbortHandler(signal: AbortSignal | undefined, abort: () => void) {
  signal?.addEventListener("abort", abort, { once: true });
  return () => signal?.removeEventListener("abort", abort);
}

function killChild(child: ChildProcessWithoutNullStreams) {
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, forceKillDelayMs).unref();
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await timeoutValue(waitForExit(child), forceKillDelayMs);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}
