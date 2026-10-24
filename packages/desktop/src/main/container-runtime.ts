import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { withoutTelemetryEnvironment } from "@blame/telemetry";
import { posix } from "node:path";
import { promisify } from "node:util";
import { runtimeToolScript, setupPath } from "./host-tool-path.ts";
import { runtimeAgentClient, runtimeAgentSupported } from "./runtime-agent.ts";

const execFileAsync = promisify(execFile);

export type ContainerRuntimeCommand =
  | "compose"
  | "container"
  | "info"
  | "inspect"
  | "network"
  | "volume";

export type ContainerRuntimeExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type ContainerRuntimeResult = {
  stdout: string;
  stderr: string;
};

type RuntimeCommandSpec = {
  args: string[];
  command: string;
  cwd?: string;
};

export type ContainerRuntime = {
  compose(
    args: string[],
    options?: ContainerRuntimeExecOptions,
  ): Promise<ContainerRuntimeResult>;
  container(
    args: string[],
    options?: ContainerRuntimeExecOptions,
  ): Promise<ContainerRuntimeResult>;
  info(options?: ContainerRuntimeExecOptions): Promise<ContainerRuntimeResult>;
  inspect<T>(
    ids: string[],
    options?: ContainerRuntimeExecOptions,
  ): Promise<T[]>;
  network(
    args: string[],
    options?: ContainerRuntimeExecOptions,
  ): Promise<ContainerRuntimeResult>;
  spawnCompose(
    args: string[],
    options?: ContainerRuntimeExecOptions,
  ): ChildProcessWithoutNullStreams;
  volume(
    args: string[],
    options?: ContainerRuntimeExecOptions,
  ): Promise<ContainerRuntimeResult>;
};

export function createContainerRuntime(
  platform: NodeJS.Platform = process.platform,
): ContainerRuntime {
  return {
    compose: (args, options) =>
      runRuntimeCommand(platform, "compose", args, options),
    container: (args, options) =>
      runRuntimeCommand(platform, "container", args, options),
    info: (options) => runRuntimeCommand(platform, "info", [], options),
    inspect: async <T>(
      ids: string[],
      options?: ContainerRuntimeExecOptions,
    ) => {
      const inspected = await Promise.all(
        ids.map((id) => inspectRuntimeId<T>(platform, id, options)),
      );
      return inspected.flat();
    },
    network: (args, options) =>
      runRuntimeCommand(platform, "network", args, options),
    spawnCompose: (args, options) =>
      spawnRuntimeCommand(platform, "compose", args, options),
    volume: (args, options) =>
      runRuntimeCommand(platform, "volume", args, options),
  };
}

async function inspectRuntimeId<T>(
  platform: NodeJS.Platform,
  id: string,
  options?: ContainerRuntimeExecOptions,
) {
  try {
    const { stdout } = await runRuntimeCommand(
      platform,
      "inspect",
      [id],
      options,
    );
    return parseInspectOutput<T>(stdout);
  } catch {
    return [];
  }
}

export function parseInspectOutput<T>(stdout: string) {
  const parsed = JSON.parse(stdout) as unknown;
  if (Array.isArray(parsed)) return parsed as T[];
  return parsed && typeof parsed === "object" ? [parsed as T] : [];
}

export function containerRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    BLAME_CONTAINER_RUNTIME: runtimeName(process.platform),
  };
}

export function runtimeCommand(
  platform: NodeJS.Platform,
  command: ContainerRuntimeCommand,
  args: string[],
) {
  const commandArgs = runtimeCommandArgs(command, args);
  if (platform === "darwin")
    return { command: "blame-lima-runtime", args: commandArgs };
  if (platform === "win32")
    return { command: "blame-wsl2-runtime", args: commandArgs };
  return { command: "docker", args: commandArgs };
}

export function runtimeName(platform: NodeJS.Platform) {
  if (platform === "darwin") return "blame-lima";
  if (platform === "win32") return "blame-wsl2";
  return "blame-native";
}

function runtimeCommandArgs(command: ContainerRuntimeCommand, args: string[]) {
  if (command === "container") return args;
  if (command === "info") return ["info", ...args];
  if (command === "inspect") return ["inspect", ...args];
  return [command, ...args];
}

async function runRuntimeCommand(
  platform: NodeJS.Platform,
  command: ContainerRuntimeCommand,
  args: string[],
  options: ContainerRuntimeExecOptions = {},
) {
  const env = runtimeEnvironment(options.env, platform);
  if (useRuntimeAgent(platform, env)) {
    try {
      return await runtimeAgentClient({ env, platform }).exec({
        args: runtimeCommandArgs(command, args),
        command: "docker",
        cwd: options.cwd ? runtimeCwdPath(options.cwd, platform) : undefined,
        env,
        timeoutMs: options.timeoutMs,
        user: "root",
      });
    } catch (error) {
      if (
        runtimeAgentCommandFailed(error) ||
        !runtimeAgentFallbackAllowed(command, args)
      ) {
        throw error;
      }
    }
  }
  const commandSpec = runtimeCommandWithContext(platform, command, args, {
    cwd: options.cwd,
    env,
  });
  const executableSpec = executableRuntimeCommand(platform, commandSpec, env);
  const result = await execFileAsync(
    executableSpec.command,
    executableSpec.args,
    {
      cwd: commandSpec.cwd,
      env,
      timeout: options.timeoutMs,
    },
  );
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

function spawnRuntimeCommand(
  platform: NodeJS.Platform,
  command: ContainerRuntimeCommand,
  args: string[],
  options: ContainerRuntimeExecOptions = {},
) {
  const env = runtimeEnvironment(options.env, platform);
  if (useRuntimeAgent(platform, env)) {
    return runtimeAgentClient({ env, platform }).spawn({
      args: runtimeCommandArgs(command, args),
      command: "docker",
      cwd: options.cwd ? runtimeCwdPath(options.cwd, platform) : undefined,
      env,
      user: "root",
    });
  }
  const commandSpec = runtimeCommandWithContext(platform, command, args, {
    cwd: options.cwd,
    env,
  });
  const executableSpec = executableRuntimeCommand(platform, commandSpec, env);
  return spawn(executableSpec.command, executableSpec.args, {
    cwd: commandSpec.cwd,
    env,
  });
}

function commandWithRuntimeCwd(
  platform: NodeJS.Platform,
  spec: RuntimeCommandSpec,
  cwd?: string,
  env: NodeJS.ProcessEnv = {},
): RuntimeCommandSpec {
  if (platform !== "darwin" && platform !== "win32") return { ...spec, cwd };
  const runtimeCwd = cwd ? runtimeCwdPath(cwd, platform) : undefined;
  const environment = runtimeGuestEnvironmentArguments(env);
  const changeDirectory = runtimeCwd ? `cd ${shellQuote(runtimeCwd)} && ` : "";
  return {
    args: [
      "sh",
      "-lc",
      `${changeDirectory}exec ${environment.length ? `env ${environment.join(" ")} ` : ""}docker ${spec.args.map(shellQuote).join(" ")}`,
    ],
    command: spec.command,
  };
}

export function runtimeCommandWithContext(
  platform: NodeJS.Platform,
  command: ContainerRuntimeCommand,
  args: string[],
  options: ContainerRuntimeExecOptions = {},
) {
  const env = runtimeEnvironment(options.env, platform);
  return commandWithRuntimeCwd(
    platform,
    runtimeCommand(platform, command, args),
    options.cwd,
    env,
  );
}

export function runtimeAgentFallbackAllowed(
  command: ContainerRuntimeCommand,
  args: string[],
) {
  if (command === "info" || command === "inspect") return true;
  const operation =
    command === "compose" ? composeOperation(args) : args[0]?.toLowerCase();
  if (command === "compose") {
    return new Set(["config", "images", "logs", "ls", "port", "ps", "top"]).has(
      operation ?? "",
    );
  }
  if (command === "container") {
    return new Set(["inspect", "logs", "port", "ps", "stats", "top"]).has(
      operation ?? "",
    );
  }
  return new Set(["inspect", "ls"]).has(operation ?? "");
}

function composeOperation(args: string[]) {
  const flagsWithValues = new Set([
    "--env-file",
    "--file",
    "--project-directory",
    "--project-name",
    "--profile",
    "-f",
    "-p",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (flagsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return argument.toLowerCase();
  }
  return undefined;
}

function runtimeGuestEnvironmentArguments(env: NodeJS.ProcessEnv) {
  return Object.entries(env)
    .filter(
      ([key, value]) =>
        typeof value === "string" && runtimeGuestEnvironmentKey(key),
    )
    .map(([key, value]) => shellQuote(`${key}=${value}`));
}

function runtimeGuestEnvironmentKey(key: string) {
  return (
    key === "BLAME_CONTAINER_RUNTIME" ||
    key === "BLAME_DOCKER_COMPOSE_FILE" ||
    key === "BLAME_HOST_GID" ||
    key === "BLAME_HOST_UID" ||
    key === "BLAME_INITIALIZATION_DIR" ||
    key === "BLAME_PROJECT_ROOT" ||
    key === "BLAME_WORKTREE_ROOT" ||
    key === "CI" ||
    key === "COMPOSE_PROJECT_NAME" ||
    key === "npm_config_yes"
  );
}

function executableRuntimeCommand(
  platform: NodeJS.Platform,
  spec: RuntimeCommandSpec,
  env: NodeJS.ProcessEnv,
): RuntimeCommandSpec {
  if (platform !== "win32") return spec;
  const script = runtimeToolScript(spec.command, { env, platform });
  if (!script) return spec;
  return {
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...spec.args,
    ],
    command: "powershell.exe",
  };
}

function runtimeEnvironment(
  env: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform,
) {
  return withoutTelemetryEnvironment(
    env ?? {
      ...process.env,
      PATH: setupPath({ platform }),
    },
  );
}

function useRuntimeAgent(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  return (
    runtimeAgentSupported(platform) && env.BLAME_DISABLE_RUNTIME_AGENT !== "1"
  );
}

function runtimeAgentCommandFailed(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    (error as { runtimeAgentCommandFailed?: boolean })
      .runtimeAgentCommandFailed,
  );
}

function runtimeCwdPath(path: string, platform: NodeJS.Platform) {
  if (platform !== "win32" || path.startsWith("/")) return path;
  return windowsPathToWslPath(path) ?? path;
}

function windowsPathToWslPath(path: string) {
  const normalized = path.replace(/\//g, "\\");
  const match = normalized.match(/^([a-zA-Z]):\\?(.*)$/);
  if (!match) return undefined;
  const drive = match[1].toLowerCase();
  const rest = match[2].split("\\").filter(Boolean);
  return posix.join("/mnt", drive, ...rest);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
