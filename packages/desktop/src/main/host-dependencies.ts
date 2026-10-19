import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withoutTelemetryEnvironment } from "@blame/telemetry";
import type { RuntimeProfileId } from "@blame/preview-runtime";
import {
  createRuntimeManager,
  type RuntimeDependencyIssue,
} from "./runtime-manager.ts";

const execFileAsync = promisify(execFile);
const commandTimeoutMs = 15_000;
const minimumNodeMajorVersion = 22;

export type HostDependencyName =
  | "git"
  | "blame-runtime"
  | "cline-sdk"
  | "containerd"
  | "nerdctl"
  | "nerdctl-compose"
  | "node"
  | "corepack"
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "pip";

export type HostDependencyStatus = "missing" | "unavailable" | "unsupported";

export type HostDependencyIssue = {
  action: string;
  message: string;
  name: HostDependencyName;
  status: HostDependencyStatus;
};

export type HostDependencyReport = {
  issues: HostDependencyIssue[];
  ok: boolean;
};

export type HostDependencyCheckInput = {
  env?: NodeJS.ProcessEnv;
  // False for work that runs straight on this machine (opening or creating
  // a project): only host tools such as Git matter then.
  includeRuntime?: boolean;
  platform?: NodeJS.Platform;
  runtimeProfile?: RuntimeProfileId;
  setupScript: string;
};

type CommandRunner = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

type CheckContext = {
  env?: NodeJS.ProcessEnv;
  includeRuntime?: boolean;
  platform: NodeJS.Platform;
  runtimeProfile?: RuntimeProfileId;
  run: CommandRunner;
};

export class HostDependencyError extends Error {
  readonly report: HostDependencyReport;

  constructor(report: HostDependencyReport) {
    super(formatHostDependencyReport(report));
    this.name = "HostDependencyError";
    this.report = report;
  }
}

export async function assertHostDependencies(input: HostDependencyCheckInput) {
  const report = await checkHostDependencies(input);
  if (!report.ok) throw new HostDependencyError(report);
  return report;
}

export async function checkHostDependencies(
  input: HostDependencyCheckInput,
  run: CommandRunner = runCommand,
): Promise<HostDependencyReport> {
  const context = {
    env: input.env,
    includeRuntime: input.includeRuntime,
    platform: input.platform ?? process.platform,
    runtimeProfile: input.runtimeProfile,
    run,
  };
  const issues = await hostDependencyIssues(input.setupScript, context);
  return { issues, ok: issues.length === 0 };
}

export function formatHostDependencyReport(report: HostDependencyReport) {
  if (report.ok) return "Host dependencies are ready.";
  return [
    "Blame cannot prepare this project because host dependencies are missing or unavailable.",
    ...report.issues.map((issue) => `- ${issue.message} ${issue.action}`),
  ].join("\n");
}

export function requiresNodeTooling(setupScript: string) {
  return /\b(?:node|npm|npx|pnpm|yarn|corepack)\b/.test(
    scriptWithoutShellComments(setupScript),
  );
}

export function parseNodeMajorVersion(version: string) {
  const match = version.trim().match(/^v?(\d+)\./);
  return match ? Number(match[1]) : null;
}

async function hostDependencyIssues(
  setupScript: string,
  context: CheckContext,
) {
  const issues: HostDependencyIssue[] = [];
  if (contextRequiresContainerRuntime(context)) {
    issues.push(...(await containerRuntimeIssues(context)));
  }
  const checks = [checkGit(context)];
  if (requiresNodeTooling(setupScript)) {
    checks.push(checkNode(context), checkCorepack(context));
  }
  checks.push(...barePackageManagerChecks(setupScript, context));
  issues.push(
    ...(await Promise.all(checks)).filter(
      (issue): issue is HostDependencyIssue => Boolean(issue),
    ),
  );
  return issues;
}

function contextRequiresContainerRuntime(context: CheckContext) {
  if (context.includeRuntime === false) return false;
  return (
    !context.runtimeProfile || context.runtimeProfile === "local-container"
  );
}

function barePackageManagerChecks(setupScript: string, context: CheckContext) {
  return [
    ...bareCommandCheck(setupScript, context, "npm"),
    ...bareCommandCheck(setupScript, context, "pnpm"),
    ...bareCommandCheck(setupScript, context, "yarn"),
    ...bareCommandCheck(setupScript, context, "bun"),
    ...bareCommandCheck(setupScript, context, "pip"),
  ];
}

function bareCommandCheck(
  setupScript: string,
  context: CheckContext,
  command: Extract<HostDependencyName, "npm" | "pnpm" | "yarn" | "bun" | "pip">,
) {
  if (!requiresBareCommand(setupScript, command)) return [];
  return [missingToolIssue(context, command, ["--version"], command)];
}

export function requiresBareCommand(setupScript: string, command: string) {
  return new RegExp(`(?<!corepack\\s)\\b${escapeRegExp(command)}\\b`).test(
    scriptWithoutShellComments(setupScript),
  );
}

async function containerRuntimeIssues(context: CheckContext) {
  const runtime = createRuntimeManager(
    { env: context.env, platform: context.platform },
    context.run,
  );
  const report = await runtime.checkRuntimeDependencies();
  return report.issues.map((issue) => runtimeDependencyIssue(context, issue));
}

async function checkGit(context: CheckContext) {
  return missingToolIssue(context, "git", ["--version"], "git");
}

function runtimeDependencyIssue(
  context: CheckContext,
  issue: RuntimeDependencyIssue,
) {
  if (issue.action) {
    return {
      action: issue.action,
      message: hostDependencyMessage(issue.name, issue.status),
      name: issue.name,
      status: issue.status,
    };
  }
  if (issue.name === "containerd") {
    return containerdUnavailableIssue(context.platform, issue.error);
  }
  if (issue.name === "blame-runtime" && issue.status === "missing") {
    return hostDependencyIssue(context.platform, issue.name, "unavailable");
  }
  return hostDependencyIssue(context.platform, issue.name, issue.status);
}

async function checkNode(context: CheckContext) {
  try {
    const version = await context.run("node", ["--version"], context.env);
    const major = parseNodeMajorVersion(version);
    if (major === null || major < minimumNodeMajorVersion) {
      return hostDependencyIssue(context.platform, "node", "unsupported");
    }
    return null;
  } catch {
    return hostDependencyIssue(context.platform, "node", "missing");
  }
}

async function checkCorepack(context: CheckContext) {
  return missingToolIssue(context, "corepack", ["--version"], "corepack");
}

async function missingToolIssue(
  context: CheckContext,
  command: string,
  args: string[],
  name: HostDependencyName,
) {
  try {
    await context.run(command, args, context.env);
    return null;
  } catch {
    return hostDependencyIssue(context.platform, name, "missing");
  }
}

function hostDependencyIssue(
  platform: NodeJS.Platform,
  name: HostDependencyName,
  status: HostDependencyStatus,
): HostDependencyIssue {
  return {
    action: hostDependencyAction(platform, name, status),
    message: hostDependencyMessage(name, status),
    name,
    status,
  };
}

function containerdUnavailableIssue(
  platform: NodeJS.Platform,
  error: unknown,
): HostDependencyIssue {
  const text = commandErrorText(error);
  if (/rootless containerd not running/i.test(text)) {
    return {
      action: rootlessContainerdAction(platform),
      message: "Rootless containerd is not running.",
      name: "containerd",
      status: "unavailable",
    };
  }
  if (/permission denied/i.test(text) && /containerd\.sock/i.test(text)) {
    return {
      action: rootlessContainerdAction(platform),
      message: "containerd is running, but Blame cannot access its socket.",
      name: "containerd",
      status: "unavailable",
    };
  }
  return hostDependencyIssue(platform, "containerd", "unavailable");
}

function rootlessContainerdAction(platform: NodeJS.Platform) {
  if (platform === "linux")
    return "Start a user-accessible runtime with containerd-rootless-setuptool.sh install, then recheck.";
  return hostDependencyAction(platform, "containerd", "unavailable");
}

function hostDependencyMessage(
  name: HostDependencyName,
  status: HostDependencyStatus,
) {
  if (name === "blame-runtime") return "Blame Runtime is not available.";
  if (name === "cline-sdk")
    return "Cline SDK is not installed in Blame Runtime.";
  if (name === "containerd") return "containerd is not available.";
  if (name === "nerdctl-compose") return "nerdctl compose is not available.";
  if (name === "node" && status === "unsupported")
    return "Node.js 22 or newer is required for this setup script.";
  return `${hostDependencyLabel(name)} is not available.`;
}

function hostDependencyAction(
  platform: NodeJS.Platform,
  name: HostDependencyName,
  status: HostDependencyStatus,
) {
  if (platform === "darwin") return macHostDependencyAction(name, status);
  if (platform === "win32") return windowsHostDependencyAction(name, status);
  return linuxHostDependencyAction(name, status);
}

function macHostDependencyAction(
  name: HostDependencyName,
  status: HostDependencyStatus,
) {
  if (name === "git")
    return "Install Xcode Command Line Tools or run brew install git.";
  if (name === "cline-sdk")
    return "Repair Blame Lima Runtime from Blame runtime setup.";
  if (containerRuntimeDependency(name))
    return "Start Blame Lima Runtime and ensure containerd, nerdctl, and nerdctl compose are available.";
  if (name === "corepack")
    return "Install Node.js 22 or newer, then run corepack --version.";
  if (name === "npm")
    return "Install Node.js 22 or newer with npm before creating the project.";
  if (name === "pnpm")
    return "Install pnpm or enable it through Corepack before creating the project.";
  if (name === "yarn")
    return "Install Yarn or enable it through Corepack before creating the project.";
  if (name === "bun")
    return "Install Bun from https://bun.sh before creating the project.";
  if (name === "pip")
    return "Install Python with pip before creating the project.";
  return status === "unsupported"
    ? "Upgrade Node.js with nvm, fnm, or the official installer."
    : "Install Node.js 22 or newer with nvm, fnm, or the official installer.";
}

function windowsHostDependencyAction(
  name: HostDependencyName,
  status: HostDependencyStatus,
) {
  if (name === "git")
    return "Install Git for Windows or run winget install Git.Git.";
  if (name === "cline-sdk")
    return "Repair Blame WSL2 Runtime from Blame runtime setup.";
  if (containerRuntimeDependency(name))
    return "Start Blame WSL2 Runtime and ensure containerd, nerdctl, and nerdctl compose are available.";
  if (name === "corepack")
    return "Install Node.js 22 or newer, then run corepack --version.";
  if (name === "npm")
    return "Install Node.js 22 or newer with npm before creating the project.";
  if (name === "pnpm")
    return "Install pnpm or run corepack enable before creating the project.";
  if (name === "yarn")
    return "Install Yarn or run corepack enable before creating the project.";
  if (name === "bun")
    return "Install Bun from https://bun.sh before creating the project.";
  if (name === "pip")
    return "Install Python with pip before creating the project.";
  return status === "unsupported"
    ? "Upgrade Node.js with winget install OpenJS.NodeJS.LTS."
    : "Install Node.js with winget install OpenJS.NodeJS.LTS.";
}

function linuxHostDependencyAction(
  name: HostDependencyName,
  status: HostDependencyStatus,
) {
  if (name === "git") return "Install git with your system package manager.";
  if (name === "cline-sdk")
    return "Repair Blame Native Runtime from Blame runtime setup.";
  if (containerRuntimeDependency(name))
    return "Start Blame Native Runtime and ensure containerd, nerdctl, and nerdctl compose are available.";
  if (name === "corepack")
    return "Install Node.js 22 or newer, then run corepack --version.";
  if (name === "npm")
    return "Install Node.js 22 or newer with npm before creating the project.";
  if (name === "pnpm")
    return "Install pnpm or run corepack enable before creating the project.";
  if (name === "yarn")
    return "Install Yarn or run corepack enable before creating the project.";
  if (name === "bun")
    return "Install Bun from https://bun.sh before creating the project.";
  if (name === "pip")
    return "Install python3-pip with your system package manager.";
  return status === "unsupported"
    ? "Upgrade Node.js with your system package manager, nvm, or fnm."
    : "Install Node.js 22 or newer with your system package manager, nvm, or fnm.";
}

function hostDependencyLabel(name: HostDependencyName) {
  const labels: Record<HostDependencyName, string> = {
    "blame-runtime": "Blame Runtime",
    "cline-sdk": "Cline SDK",
    containerd: "containerd",
    corepack: "Corepack",
    git: "Git",
    nerdctl: "nerdctl",
    "nerdctl-compose": "nerdctl compose",
    node: "Node.js",
    npm: "npm",
    pnpm: "pnpm",
    yarn: "Yarn",
    bun: "Bun",
    pip: "pip",
  };
  return labels[name];
}

function containerRuntimeDependency(name: HostDependencyName) {
  return ["blame-runtime", "containerd", "nerdctl", "nerdctl-compose"].includes(
    name,
  );
}

function scriptWithoutShellComments(setupScript: string) {
  return setupScript
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runCommand(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) {
  const { stdout } = await execFileAsync(command, args, {
    env: withoutTelemetryEnvironment(env ?? process.env),
    shell: process.platform === "win32",
    timeout: commandTimeoutMs,
  });
  return stdout;
}

function commandErrorText(error: unknown) {
  if (!error || typeof error !== "object")
    return error instanceof Error ? error.message : String(error);
  const record = error as Record<string, unknown>;
  return [record.message, record.stdout, record.stderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}
