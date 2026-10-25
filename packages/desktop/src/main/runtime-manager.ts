import { execFile, spawn } from "node:child_process";
import type { RuntimeProgress } from "@blame/app";
import { withoutTelemetryEnvironment } from "@blame/telemetry";
import {
  runtimeCommand,
  runtimeName,
  type ContainerRuntimeCommand,
} from "./container-runtime.ts";
import { runtimeToolScript } from "./host-tool-path.ts";
import {
  runtimeTelemetry,
  type RuntimeTelemetryOperation,
  type RuntimeTelemetryOperationName,
  type RuntimeTelemetryProbeName,
  type RuntimeTelemetryRecorder,
} from "./runtime-telemetry.ts";

const commandTimeoutMs = 15_000;
const lifecycleCommandTimeoutMs = 30 * 60_000;
const readinessTimeoutMs = 90_000;
const readinessPollIntervalMs = 1_000;

export type RuntimeState =
  | "ready"
  | "missing"
  | "repairable"
  | "unsupported"
  | "broken";

export type RuntimeDependencyName =
  | "blame-runtime"
  | "cline-sdk"
  | "docker"
  | "docker-compose"
  | "git";

export type RuntimeDependencyStatus = "missing" | "unavailable" | "unsupported";

export type RuntimeDependencyIssue = {
  action?: string;
  error?: unknown;
  name: RuntimeDependencyName;
  runtimeStatus?: RuntimeState;
  status: RuntimeDependencyStatus;
  // The runtime is installed and only its provisioning is out of date: a
  // routine update, not a breakdown.
  update?: boolean;
  // Installed VM is stopped; starting it is not a repair.
  start?: boolean;
};

type ManagedRuntimeCheckName =
  | "lima"
  | "vm"
  | "host-home"
  | "wsl"
  | "wsl2"
  | "runtime-version"
  | "agent-version"
  | "distro"
  | "agent"
  | "node"
  | "semantic-harness"
  | "package-managers"
  | RuntimeDependencyName;

type ManagedRuntimeCheckStatus =
  | "available"
  | "missing"
  | "unavailable"
  | "unsupported";

type ManagedRuntimeStatusCheck = {
  action?: string;
  name: ManagedRuntimeCheckName;
  status: ManagedRuntimeCheckStatus;
};

type ManagedRuntimeStatusReport = {
  action?: string;
  checks?: ManagedRuntimeStatusCheck[];
  status?: RuntimeState;
};

export type RuntimeStatusReport = {
  issues: RuntimeDependencyIssue[];
  platform: NodeJS.Platform;
  runtime: string;
  status: RuntimeState;
  // True when every problem is an outdated version of an installed runtime.
  updateRequired: boolean;
  startRequired?: boolean;
};

export type RuntimeManagerInput = {
  env?: NodeJS.ProcessEnv;
  onProgress?: RuntimeProgressHandler;
  platform?: NodeJS.Platform;
};

export type { RuntimeProgress } from "@blame/app";

export type RuntimeProgressHandler = (progress: RuntimeProgress) => void;

export type RuntimeCommandRunner = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
  onOutput?: (output: string) => void,
) => Promise<string>;

type RuntimeManagerContext = {
  env?: NodeJS.ProcessEnv;
  observation?: RuntimeTelemetryOperation;
  onProgress?: RuntimeProgressHandler;
  platform: NodeJS.Platform;
  probesEnabled?: boolean;
  run: RuntimeCommandRunner;
};

type RuntimeManagerAction = (
  context: RuntimeManagerContext,
) => Promise<RuntimeStatusReport>;

export class RuntimeManager {
  private readonly context: RuntimeManagerContext;
  private readonly telemetry: RuntimeTelemetryRecorder;

  constructor(
    input: RuntimeManagerInput = {},
    run: RuntimeCommandRunner = runCommand,
    telemetry: RuntimeTelemetryRecorder = runtimeTelemetry,
  ) {
    this.context = {
      env: input.env,
      onProgress: input.onProgress,
      platform: input.platform ?? process.platform,
      run,
    };
    this.telemetry = telemetry;
  }

  getRuntimeStatus() {
    return this.checkRuntimeDependencies();
  }

  async checkRuntimeDependencies(): Promise<RuntimeStatusReport> {
    return this.observe("status", checkRuntimeStatus);
  }

  async ensureRuntimeReady() {
    return this.observe("ensure", ensureRuntimeOperation);
  }

  async repairRuntime() {
    return this.observe("repair", repairRuntimeOperation);
  }

  async resetRuntime() {
    return this.observe("reset", resetRuntimeOperation);
  }

  async uninstallRuntime() {
    return this.observe("uninstall", uninstallRuntimeOperation);
  }

  private observe(
    operation: RuntimeTelemetryOperationName,
    action: RuntimeManagerAction,
  ) {
    return this.telemetry.runOperation(
      runtimeName(this.context.platform),
      operation,
      (observation) => action({ ...this.context, observation }),
    );
  }
}

export function createRuntimeManager(
  input: RuntimeManagerInput = {},
  run: RuntimeCommandRunner = runCommand,
  telemetry: RuntimeTelemetryRecorder = runtimeTelemetry,
) {
  return new RuntimeManager(input, run, telemetry);
}

export function getRuntimeStatus(input: RuntimeManagerInput = {}) {
  return createRuntimeManager(input).getRuntimeStatus();
}

export function checkRuntimeDependencies(input: RuntimeManagerInput = {}) {
  return createRuntimeManager(input).checkRuntimeDependencies();
}

export function ensureRuntimeReady(input: RuntimeManagerInput = {}) {
  return createRuntimeManager(input).ensureRuntimeReady();
}

export function repairRuntime(input: RuntimeManagerInput = {}) {
  return createRuntimeManager(input).repairRuntime();
}

export function resetRuntime(input: RuntimeManagerInput = {}) {
  return createRuntimeManager(input).resetRuntime();
}

export function uninstallRuntime(input: RuntimeManagerInput = {}) {
  return createRuntimeManager(input).uninstallRuntime();
}

/**
 * Stops the Blame Runtime when the app quits, so the VM's memory goes back
 * to the computer; the next start boots it again. The command outlives the
 * app, which does not wait for it.
 */
export function stopRuntimeInBackground(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  if (!managedRuntimePlatform(platform)) return;
  const environment = withoutTelemetryEnvironment(env);
  const spec = executableRuntimeCommand(
    runtimeBinary(platform),
    ["stop"],
    environment,
  );
  try {
    spawn(spec.command, spec.args, {
      detached: true,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    })
      .on("error", () => undefined)
      .unref();
  } catch {
    // The runtime keeps running; the next start finds it up.
  }
}

async function ensureRuntimeOperation(context: RuntimeManagerContext) {
  context.onProgress?.({ phase: "checking" });
  const report = await checkRuntimeStatus(context);
  context.observation?.initial(report);
  if (report.status === "ready") {
    context.observation?.readinessPolls(0);
    return report;
  }
  await runLifecyclePhase(context, "ensure");
  return waitForReadinessPhase(context);
}

function repairRuntimeOperation(context: RuntimeManagerContext) {
  return runReadyLifecycleOperation(context, "repair");
}

function resetRuntimeOperation(context: RuntimeManagerContext) {
  return runReadyLifecycleOperation(context, "reset");
}

async function runReadyLifecycleOperation(
  context: RuntimeManagerContext,
  command: "repair" | "reset",
) {
  await runLifecyclePhase(context, command);
  return waitForReadinessPhase(context);
}

async function uninstallRuntimeOperation(context: RuntimeManagerContext) {
  await runLifecyclePhase(context, "uninstall");
  return checkRuntimeStatus(context);
}

function checkRuntimeStatus(context: RuntimeManagerContext) {
  return observeRuntimePhase(context, "status_check", () =>
    runtimeStatusReportFromContext(context),
  );
}

function runLifecyclePhase(
  context: RuntimeManagerContext,
  command: "ensure" | "repair" | "reset" | "uninstall",
) {
  return observeRuntimePhase(context, "lifecycle_command", () =>
    runRuntimeLifecycleCommand(context, command),
  );
}

function waitForReadinessPhase(context: RuntimeManagerContext) {
  const action = () => waitForRuntimeReadiness(context);
  return (
    context.observation?.phase("readiness_wait", action, readinessOutcome) ??
    action()
  );
}

function readinessOutcome(report: RuntimeStatusReport) {
  return report.status === "ready" ? "succeeded" : "failed";
}

function observeRuntimePhase<T>(
  context: RuntimeManagerContext,
  phase: "lifecycle_command" | "readiness_wait" | "status_check",
  action: () => Promise<T>,
) {
  return context.observation?.phase(phase, action) ?? action();
}

async function runtimeDependencyIssues(context: RuntimeManagerContext) {
  if (!supportedRuntimePlatform(context.platform)) {
    return [runtimeIssue("blame-runtime", "unsupported")];
  }
  if (context.platform === "linux") return linuxRuntimeIssues(context);
  return managedRuntimeIssues(context);
}

async function linuxRuntimeIssues(context: RuntimeManagerContext) {
  const dockerIssue = await checkLinuxDocker(context);
  if (dockerIssue) return [dockerIssue];
  const connectionIssue = await checkRuntimeConnection(context);
  if (connectionIssue) return [connectionIssue];
  const composeIssue = await checkRuntimeTool(context, "compose", ["version"]);
  return composeIssue ? [composeIssue] : [];
}

async function managedRuntimeIssues(context: RuntimeManagerContext) {
  const binaryIssue = await checkManagedRuntimeBinary(context);
  if (binaryIssue) return [binaryIssue];
  const statusIssue = await checkManagedRuntimeStatus(context);
  if (statusIssue) return [statusIssue];
  const agentIssue = await checkManagedRuntimeAgent(context);
  return agentIssue ? [agentIssue] : [];
}

async function checkLinuxDocker(context: RuntimeManagerContext) {
  try {
    await observeRuntimeProbe(context, "docker", "binary", () =>
      context.run("docker", ["--version"], context.env),
    );
    return null;
  } catch (error) {
    return runtimeIssue("docker", "missing", error);
  }
}

async function checkRuntimeConnection(context: RuntimeManagerContext) {
  try {
    await observeRuntimeProbe(context, "docker", "connection", () =>
      runRuntimeCommand(context, "info", []),
    );
    return null;
  } catch (error) {
    return runtimeIssue("docker", "unavailable", error);
  }
}

async function checkRuntimeTool(
  context: RuntimeManagerContext,
  command: ContainerRuntimeCommand,
  args: string[],
) {
  try {
    await observeRuntimeProbe(context, "docker-compose", "compose", () =>
      runRuntimeCommand(context, command, args),
    );
    return null;
  } catch (error) {
    return runtimeIssue("docker-compose", "missing", error);
  }
}

async function checkManagedRuntimeBinary(context: RuntimeManagerContext) {
  try {
    await observeRuntimeProbe(context, "blame-runtime", "binary", () =>
      context.run(runtimeBinary(context.platform), ["--version"], context.env),
    );
    return null;
  } catch (error) {
    return runtimeIssue("blame-runtime", "missing", error, "missing");
  }
}

async function checkManagedRuntimeStatus(context: RuntimeManagerContext) {
  try {
    const output = await observeRuntimeProbe(
      context,
      "blame-runtime",
      "status",
      () =>
        context.run(runtimeBinary(context.platform), ["status"], context.env),
    );
    return managedRuntimeStatusIssueFromOutput(output);
  } catch (error) {
    return runtimeIssue("blame-runtime", "unavailable", error, "broken");
  }
}

async function checkManagedRuntimeAgent(context: RuntimeManagerContext) {
  try {
    const output = await observeRuntimeProbe(
      context,
      "blame-runtime",
      "agent",
      () =>
        context.run(
          runtimeBinary(context.platform),
          ["agent", "status"],
          context.env,
        ),
    );
    return parseRuntimeState(output) === "ready"
      ? null
      : managedRuntimeAgentIssue();
  } catch (error) {
    return managedRuntimeAgentIssue(error);
  }
}

function observeRuntimeProbe<T>(
  context: RuntimeManagerContext,
  dependency: RuntimeDependencyName,
  probe: RuntimeTelemetryProbeName,
  action: () => Promise<T>,
) {
  if (!context.observation || context.probesEnabled === false) return action();
  return context.observation.probe(dependency, probe, action);
}

function runRuntimeCommand(
  context: RuntimeManagerContext,
  command: ContainerRuntimeCommand,
  args: string[],
) {
  const spec = runtimeCommand(context.platform, command, args);
  return context.run(spec.command, spec.args, context.env);
}

function runRuntimeLifecycleCommand(
  context: RuntimeManagerContext,
  command: "ensure" | "repair" | "reset" | "uninstall",
) {
  if (context.platform === "linux") return Promise.resolve("");
  if (!managedRuntimePlatform(context.platform)) {
    throw new Error(`Unsupported runtime platform: ${context.platform}`);
  }
  const onOutput = createRuntimeProgressParser(context.onProgress);
  return context.run(
    runtimeBinary(context.platform),
    [command],
    context.env,
    lifecycleCommandTimeoutMs,
    onOutput,
  );
}

function createRuntimeProgressParser(onProgress?: RuntimeProgressHandler) {
  if (!onProgress) return undefined;
  let pendingOutput = "";
  return (output: string) => {
    const lines = `${pendingOutput}${output}`.split(/\r?\n/);
    pendingOutput = lines.pop() ?? "";
    for (const line of lines) emitRuntimeProgress(line, onProgress);
  };
}

function emitRuntimeProgress(line: string, onProgress: RuntimeProgressHandler) {
  const prefix = "BLAME_RUNTIME_PROGRESS ";
  if (!line.startsWith(prefix)) return;
  try {
    const progress = JSON.parse(line.slice(prefix.length)) as RuntimeProgress;
    if (runtimeProgressValid(progress)) onProgress(progress);
  } catch {
    return;
  }
}

function runtimeProgressValid(value: RuntimeProgress) {
  return (
    value &&
    [
      "checking",
      "configuring",
      "downloading",
      "installing",
      "starting",
      "verifying",
    ].includes(value.phase)
  );
}

async function waitForRuntimeReadiness(context: RuntimeManagerContext) {
  const deadline = Date.now() + readinessTimeoutMs;
  const pollingContext = { ...context, probesEnabled: false };
  let report = await runtimeStatusReportFromContext(pollingContext);
  let pollCount = 1;
  while (runtimeReadinessPending(report) && Date.now() < deadline) {
    await sleep(readinessPollIntervalMs);
    report = await runtimeStatusReportFromContext(pollingContext);
    pollCount += 1;
  }
  context.observation?.readinessPolls(pollCount);
  return report;
}

async function runtimeStatusReportFromContext(context: RuntimeManagerContext) {
  const issues = await runtimeDependencyIssues(context);
  return runtimeStatusReport(context.platform, issues);
}

function runtimeReadinessPending(report: RuntimeStatusReport) {
  return report.status !== "ready" && report.status !== "unsupported";
}

function runtimeStatusReport(
  platform: NodeJS.Platform,
  issues: RuntimeDependencyIssue[],
): RuntimeStatusReport {
  return {
    issues,
    platform,
    runtime: runtimeName(platform),
    status: runtimeState(issues),
    updateRequired: issues.length > 0 && issues.every((issue) => issue.update),
    ...(issues.length > 0 && issues.every((issue) => issue.start)
      ? { startRequired: true }
      : {}),
  };
}

function runtimeState(issues: RuntimeDependencyIssue[]): RuntimeState {
  const issue = issues[0];
  if (!issue) return "ready";
  if (issue.runtimeStatus) return issue.runtimeStatus;
  if (issue.status === "unsupported") return "unsupported";
  if (issue.status === "missing") return "missing";
  if (issue.name === "docker") return "repairable";
  return "broken";
}

function runtimeIssue(
  name: RuntimeDependencyName,
  status: RuntimeDependencyStatus,
  error?: unknown,
  runtimeStatus?: RuntimeState,
  action?: string,
): RuntimeDependencyIssue {
  return { action, error, name, runtimeStatus, status };
}

function managedRuntimeAgentIssue(error?: unknown) {
  return runtimeIssue(
    "blame-runtime",
    "missing",
    error,
    "missing",
    "Repair BlameRuntime from Blame runtime setup.",
  );
}

function managedRuntimeStatusIssueFromOutput(output: string) {
  const report = parseManagedRuntimeStatusReport(output);
  if (!report) {
    const status = parseRuntimeState(output);
    return status === "ready" ? null : managedRuntimeStatusIssue(status);
  }
  const failing =
    report.checks?.filter((item) => item.status !== "available") ?? [];
  const check = failing[0];
  if (!check) {
    const status = report.status ?? "ready";
    return status === "ready"
      ? null
      : managedRuntimeStatusIssue(status, report.action);
  }
  const issue = managedRuntimeCheckIssue(
    check,
    report.status ?? "broken",
    report.action,
  );
  if (
    failing.every((item) => item.name === "vm" && item.status === "unavailable")
  ) {
    return { ...issue, start: true };
  }
  return failing.every((item) => updateChecks.has(item.name))
    ? { ...issue, update: true }
    : issue;
}

// Checks that only fail when the installed runtime lags behind the version
// this app ships with. Re-provisioning (ensure) brings them up to date.
const updateChecks = new Set<ManagedRuntimeCheckName>([
  "agent-version",
  "runtime-version",
  "cline-sdk",
  "semantic-harness",
  "package-managers",
]);

function managedRuntimeStatusIssue(status: RuntimeState, action?: string) {
  if (status === "missing") {
    return runtimeIssue(
      "blame-runtime",
      "missing",
      undefined,
      "missing",
      action,
    );
  }
  if (status === "unsupported") {
    return runtimeIssue(
      "blame-runtime",
      "unsupported",
      undefined,
      "unsupported",
      action,
    );
  }
  return runtimeIssue(
    "blame-runtime",
    "unavailable",
    undefined,
    status,
    action,
  );
}

function managedRuntimeCheckIssue(
  check: ManagedRuntimeStatusCheck,
  runtimeStatus: RuntimeState,
  fallbackAction?: string,
) {
  return runtimeIssue(
    runtimeDependencyName(check.name),
    runtimeDependencyStatus(check.status),
    undefined,
    runtimeStatusForCheck(check, runtimeStatus),
    check.action ?? fallbackAction,
  );
}

function runtimeDependencyName(
  name: ManagedRuntimeCheckName,
): RuntimeDependencyName {
  if (
    name === "docker" ||
    name === "docker-compose" ||
    name === "git" ||
    name === "cline-sdk"
  ) {
    return name;
  }
  return "blame-runtime";
}

function runtimeDependencyStatus(
  status: ManagedRuntimeCheckStatus,
): RuntimeDependencyStatus {
  return status === "available" ? "unavailable" : status;
}

function runtimeStatusForCheck(
  check: ManagedRuntimeStatusCheck,
  fallback: RuntimeState,
) {
  if (check.name === "lima")
    return check.status === "missing" ? "missing" : "broken";
  if (check.name === "wsl" || check.name === "wsl2")
    return check.status === "unsupported" ? "unsupported" : "broken";
  if (check.name === "vm")
    return check.status === "missing" ? "missing" : fallback;
  if (check.name === "distro" || check.name === "agent") return "missing";
  if (check.status === "missing") return "repairable";
  return fallback;
}

function parseManagedRuntimeStatusReport(
  output: string,
): ManagedRuntimeStatusReport | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ManagedRuntimeStatusReport;
  } catch {
    return null;
  }
}

function parseRuntimeState(output: string): RuntimeState {
  const value = output.trim().toLowerCase();
  if (isRuntimeState(value)) return value;
  return "ready";
}

function isRuntimeState(value: string): value is RuntimeState {
  return ["ready", "missing", "repairable", "unsupported", "broken"].includes(
    value,
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function supportedRuntimePlatform(platform: NodeJS.Platform) {
  return platform === "linux" || managedRuntimePlatform(platform);
}

function managedRuntimePlatform(platform: NodeJS.Platform) {
  return platform === "darwin" || platform === "win32";
}

function runtimeBinary(platform: NodeJS.Platform) {
  if (platform === "darwin") return "blame-lima-runtime";
  if (platform === "win32") return "blame-wsl2-runtime";
  return "docker";
}

async function runCommand(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs = commandTimeoutMs,
  onOutput?: (output: string) => void,
) {
  const environment = withoutTelemetryEnvironment(env ?? process.env);
  const commandSpec = executableRuntimeCommand(command, args, environment);
  return executeCommand(commandSpec, environment, timeoutMs, onOutput);
}

function executeCommand(
  commandSpec: { args: string[]; command: string },
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  onOutput?: (output: string) => void,
) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      commandSpec.command,
      commandSpec.args,
      {
        encoding: "utf8",
        env: environment,
        shell: false,
        timeout: timeoutMs,
      },
      (error, stdout) => completeCommand(error, stdout, resolve, reject),
    );
    if (onOutput) {
      child.stdout?.on("data", (output: string | Buffer) =>
        emitCommandOutput(onOutput, output),
      );
    }
  });
}

function completeCommand(
  error: Error | null,
  stdout: string,
  resolve: (output: string) => void,
  reject: (error: Error) => void,
) {
  if (error) {
    reject(error);
    return;
  }
  resolve(stdout);
}

function emitCommandOutput(
  onOutput: (output: string) => void,
  output: string | Buffer,
) {
  try {
    onOutput(output.toString());
  } catch {
    return;
  }
}

function executableRuntimeCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  if (process.platform !== "win32") return { args, command };
  const script = runtimeToolScript(command, { env, platform: "win32" });
  if (script) {
    return {
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        ...args,
      ],
      command: "powershell.exe",
    };
  }
  return {
    args: ["/d", "/s", "/c", commandPromptLine(command, args, env)],
    command: "cmd.exe",
  };
}

function commandPromptLine(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  return [
    "call",
    commandPromptQuote(windowsBatchCommand(command)),
    ...args.map(commandPromptQuote),
  ].join(" ");
}

function windowsBatchCommand(command: string) {
  if (command === "blame-wsl2-runtime") return "blame-wsl2-runtime.cmd";
  if (command === "blame-lima-runtime") return "blame-lima-runtime.cmd";
  return command;
}

function commandPromptQuote(value: string) {
  return `"${value.replace(/(["^&|<>])/g, "^$1")}"`;
}
