import { runtimeDistroName } from "./desktop-runtime-environment.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { LightWorkspaceExecutionRequest } from "@blame/agent-runtime";
import { withoutTelemetryEnvironment } from "@blame/telemetry";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import log from "electron-log";
import { setupPath } from "./host-tool-path.ts";

type AgentRequest = {
  id: number;
  method: string;
  params: Record<string, unknown>;
};

type AgentResponse = {
  error?: { message?: string; stderr?: string; stdout?: string };
  id: number;
  ok: boolean;
  result?: unknown;
};

type AgentEvent = {
  data?: string;
  event: "spawn";
  processId: string;
  type: "stdout" | "stderr" | "exit";
  code?: number | null;
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer?: NodeJS.Timeout;
};

class RuntimeAgentTransportError extends Error {}

type AgentExecInput = {
  args: string[];
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  user?: "blame" | "root";
};

type AgentSpawnInput = Omit<AgentExecInput, "timeoutMs">;

type AgentExecResult = {
  stderr: string;
  stdout: string;
};

type AgentScanEnvFilesResult = {
  runtime: string[];
  templates: string[];
};

type AgentReadExistingFilesResult = {
  files: Record<string, string | null>;
};

export type AgentClineHubResult = {
  action?: string;
  authToken?: string;
  status?: string;
  url?: string;
};

type RuntimeAgentClientInput = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
};

const defaultTimeoutMs = 60_000;
const clients = new Map<string, RuntimeAgentClient>();

export function runtimeAgentClient(input: RuntimeAgentClientInput = {}) {
  const platform = input.platform ?? process.platform;
  const key = platform;
  const current = clients.get(key);
  if (current) return current;
  const next = new RuntimeAgentClient(input);
  clients.set(key, next);
  return next;
}

export function runtimeAgentSupported(platform = process.platform) {
  return platform === "darwin" || platform === "win32";
}

export class RuntimeAgentClient {
  private nextId = 1;
  private process?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly platform: NodeJS.Platform;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly spawnProcess: typeof spawn;
  private readonly streams = new Map<string, AgentChildProcess>();
  private readonly bufferedEvents = new Map<string, AgentEvent[]>();

  constructor(input: RuntimeAgentClientInput = {}) {
    this.platform = input.platform ?? process.platform;
    this.env = input.env;
    this.spawnProcess = input.spawnProcess ?? spawn;
  }

  async exec(input: AgentExecInput): Promise<AgentExecResult> {
    const result = await this.request(
      "exec",
      input,
      input.timeoutMs ? input.timeoutMs + 2_000 : undefined,
    );
    return result as AgentExecResult;
  }

  spawn(input: AgentSpawnInput) {
    const child = new AgentChildProcess((processId) => {
      void this.kill(processId).catch(() => undefined);
    });
    void this.request("spawn", input)
      .then((result) => {
        const processId = String((result as { processId: string }).processId);
        child.attach(processId);
        this.streams.set(processId, child);
        this.flushBufferedEvents(processId, child);
      })
      .catch((error: Error) => child.fail(error));
    return child as unknown as ChildProcessWithoutNullStreams;
  }

  async scanEnvFiles(root: string): Promise<AgentScanEnvFilesResult> {
    const result = await this.request("scanEnvFiles", { root });
    return result as AgentScanEnvFilesResult;
  }

  async readExistingFiles(
    paths: string[],
  ): Promise<AgentReadExistingFilesResult> {
    const result = await this.request("readExistingFiles", { paths });
    return result as AgentReadExistingFilesResult;
  }

  async clineHubEnsure(): Promise<AgentClineHubResult> {
    // Provisioning can replace the agent on disk while this RPC process is
    // still running. Always load the installed launcher for hub lifecycle work.
    const result = await this.requestWithTransportRetry(
      "exec",
      {
        command: "/usr/local/bin/blame-runtime-agent",
        args: ["cline-hub-ensure"],
        user: "root",
        timeoutMs: 90_000,
      },
      90_000,
    );
    return JSON.parse(
      (result as AgentExecResult).stdout,
    ) as AgentClineHubResult;
  }

  async clineHubStatus(): Promise<AgentClineHubResult> {
    const result = await this.request("clineHubStatus", {}, 10_000);
    return result as AgentClineHubResult;
  }

  async clineHubStop(): Promise<AgentClineHubResult> {
    const result = await this.request("clineHubStop", {}, 10_000);
    return result as AgentClineHubResult;
  }

  async lightWorkspace(
    input: LightWorkspaceExecutionRequest,
    signal?: AbortSignal,
  ) {
    const operationId = randomUUID();
    return this.request(
      "lightWorkspace",
      { ...input, operationId },
      15 * 60_000,
      signal,
      () => {
        void this.request("lightWorkspaceCancel", { operationId }, 5_000).catch(
          () => undefined,
        );
      },
    );
  }

  async kill(processId: string) {
    await this.request("kill", { processId }, 5_000);
  }

  private async requestWithTransportRetry(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ) {
    try {
      return await this.request(method, params, timeoutMs);
    } catch (error) {
      if (!(error instanceof RuntimeAgentTransportError)) throw error;
      log.warn(
        `Runtime agent transport interrupted during ${method}; retrying`,
      );
      return this.request(method, params, timeoutMs);
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = defaultTimeoutMs,
    signal?: AbortSignal,
    onAbort?: () => void,
  ) {
    if (!runtimeAgentSupported(this.platform))
      return Promise.reject(new Error("Runtime agent is not supported"));
    const process = this.ensureProcess();
    const id = this.nextId;
    this.nextId += 1;
    const request: AgentRequest = {
      id,
      method,
      params: agentRequestParams(params),
    };
    return new Promise<unknown>((resolve, reject) => {
      if (signal?.aborted) {
        onAbort?.();
        reject(abortError());
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        onAbort?.();
        reject(new Error(`Runtime agent request timed out: ${method}`));
      }, timeoutMs);
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        onAbort?.();
        reject(abortError());
      };
      const cleanupResolve = (value: unknown) => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const cleanupReject = (error: Error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      };
      this.pending.set(id, {
        reject: cleanupReject,
        resolve: cleanupResolve,
        timer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      process.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
    });
  }

  private ensureProcess() {
    if (this.process && this.process.exitCode === null) return this.process;
    const spec = agentCommand(this.platform, this.env);
    log.info(`Spawning runtime agent: ${spec.command} ${spec.args.join(" ")}`);
    const child = this.spawnProcess(spec.command, spec.args, {
      env: spec.env,
      shell: false,
    });
    this.process = child;
    const lines = createInterface({ input: child.stdout, terminal: false });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (data) => {
      log.error(`Runtime agent stderr: ${data.toString()}`);
    });
    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      log.error(
        `Runtime agent process exited with code: ${code}, signal: ${signal}`,
      );
      this.process = undefined;
      this.rejectPending(
        new RuntimeAgentTransportError("Runtime agent exited"),
      );
    });
    child.once("error", (error) => {
      if (this.process !== child) return;
      log.error(`Runtime agent process error: ${error.message}`);
      this.process = undefined;
      this.rejectPending(new RuntimeAgentTransportError(error.message));
    });
    return child;
  }

  private handleLine(line: string) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (isAgentEvent(message)) {
      this.handleEvent(message);
      return;
    }
    if (isAgentResponse(message)) this.handleResponse(message);
  }

  private handleResponse(response: AgentResponse) {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
      return;
    }
    pending.reject(agentError(response));
  }

  private handleEvent(event: AgentEvent) {
    const child = this.streams.get(event.processId);
    if (!child) {
      const events = this.bufferedEvents.get(event.processId) ?? [];
      events.push(event);
      this.bufferedEvents.set(event.processId, events);
      return;
    }
    this.applyEvent(child, event);
  }

  private flushBufferedEvents(processId: string, child: AgentChildProcess) {
    const events = this.bufferedEvents.get(processId) ?? [];
    this.bufferedEvents.delete(processId);
    for (const event of events) this.applyEvent(child, event);
  }

  private applyEvent(child: AgentChildProcess, event: AgentEvent) {
    if (event.type === "stdout") child.stdout.write(event.data ?? "");
    if (event.type === "stderr") child.stderr.write(event.data ?? "");
    if (event.type === "exit") {
      this.streams.delete(event.processId);
      child.finish(event.code ?? null);
    }
  }

  private rejectPending(error: Error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const [id, child] of this.streams) {
      this.streams.delete(id);
      child.finish(1);
    }
  }
}

function abortError() {
  return new DOMException(
    "Runtime semantic workspace request aborted",
    "AbortError",
  );
}

class AgentChildProcess extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly pid = undefined;
  private processId?: string;
  private readonly stop: (processId: string) => void;

  constructor(stop: (processId: string) => void) {
    super();
    this.stop = stop;
  }

  kill(signal?: NodeJS.Signals | number) {
    if (typeof signal === "string") this.signalCode = signal;
    if (this.processId) this.stop(this.processId);
    return true;
  }

  attach(processId: string) {
    this.processId = processId;
  }

  fail(error: Error) {
    if (this.listenerCount("error") > 0) this.emit("error", error);
    else this.stderr.write(`${error.message}\n`);
    this.finish(1);
  }

  finish(code: number | null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

function agentRequestParams(params: Record<string, unknown>) {
  const env = params.env;
  if (!env || typeof env !== "object") return params;
  return {
    ...params,
    env: runtimeCommandEnvironment(env as NodeJS.ProcessEnv),
  };
}

function runtimeCommandEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => typeof value === "string" && runtimeEnvironmentKey(key),
    ),
  );
}

function runtimeEnvironmentKey(key: string) {
  return (
    key === "CI" ||
    key === "COMPOSE_PROJECT_NAME" ||
    key === "CONTAINERD_NAMESPACE" ||
    key === "PATH" ||
    key === "npm_config_yes" ||
    key.startsWith("BLAME_") ||
    key.startsWith("GIT_") ||
    key.startsWith("SSH_")
  );
}

function agentCommand(platform: NodeJS.Platform, env?: NodeJS.ProcessEnv) {
  const nextEnv = {
    ...withoutTelemetryEnvironment(process.env),
    ...env,
    PATH: setupPath({ env, platform }),
  };
  const sanitizedEnv = withoutTelemetryEnvironment(nextEnv);
  if (platform === "win32") {
    return {
      args: [
        "-d",
        runtimeDistroName(sanitizedEnv),
        "-u",
        "root",
        "--exec",
        "blame-runtime-agent",
        "serve",
      ],
      command: "wsl.exe",
      env: sanitizedEnv,
    };
  }
  return {
    args: ["agent", "serve"],
    command: "blame-lima-runtime",
    env: sanitizedEnv,
  };
}

function isAgentResponse(value: unknown): value is AgentResponse {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as AgentResponse).id === "number" &&
    typeof (value as AgentResponse).ok === "boolean",
  );
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as AgentEvent).event === "spawn" &&
    typeof (value as AgentEvent).processId === "string",
  );
}

function agentError(response: AgentResponse) {
  const message = [
    response.error?.message || "Runtime agent request failed",
    response.error?.stdout,
    response.error?.stderr,
  ]
    .filter(
      (part): part is string =>
        typeof part === "string" && Boolean(part.trim()),
    )
    .join("\n");
  const error = new Error(message);
  Object.assign(error, {
    runtimeAgentCommandFailed: true,
    stderr: response.error?.stderr ?? "",
    stdout: response.error?.stdout ?? "",
  });
  return error;
}
