import { runtimeDistroName } from "./desktop-runtime-environment.ts";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { withoutTelemetryEnvironment } from "@blame/telemetry";
import { existsSync } from "node:fs";
import {
  appendFile as appendHostFile,
  chmod as chmodHost,
  mkdir as mkdirHost,
  readFile as readHostFile,
  rename as renameHost,
  rm as rmHost,
  writeFile as writeHostFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { hostGitCommand } from "./host-git.ts";
import { runtimeToolScript, setupPath } from "./host-tool-path.ts";
import { runtimeAgentClient, runtimeAgentSupported } from "./runtime-agent.ts";
import {
  platformWorktreeRoot,
  runtimeExecution,
  type WorkspaceExecution,
  type WorkspaceMode,
} from "./workspace-mode.ts";
import log from "electron-log";

const execFileAsync = promisify(execFile);
const vmRuntimeWorktreeRoot =
  "/home/blame/.local/share/blame/runtime/worktrees";
const macosRuntimeWorktreeSegment =
  "/Library/Application Support/Blame/runtime/worktrees";
const ignoredProjectSearchDirectories = [
  ".blame",
  ".blame-preview",
  ".cache",
  ".git",
  ".generated",
  ".next",
  ".nuxt",
  ".output",
  ".pnpm-store",
  ".svelte-kit",
  ".turbo",
  ".venv",
  "__pycache__",
  "coverage",
  "node_modules",
  "site-packages",
  "venv",
];
const maxProjectFileSearchResults = 30_000;

type RuntimeOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execution?: WorkspaceExecution;
  maxBuffer?: number;
  platform?: NodeJS.Platform;
  user?: "blame" | "root";
};

type RuntimeCommandSpec = {
  args: string[];
  command: string;
  cwd?: string;
  // cmd.exe reads its own command line: Node must not re-quote it.
  windowsVerbatimArguments?: boolean;
};

export function worktreeRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  mode: WorkspaceMode = "local-container",
) {
  return platformWorktreeRoot(platform, env, mode);
}

export function worktreePath(input: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  repositoryRoot: string;
  storyId: string;
  title: string;
  mode?: WorkspaceMode;
}) {
  const platform = input.platform ?? process.platform;
  const repositoryName = repositoryBasename(input.repositoryRoot, platform);
  const slug = storySlug(input.storyId, input.title);
  const root = platformWorktreeRoot(
    platform,
    input.env ?? process.env,
    input.mode ?? "local-container",
  );
  const parts = [root, repositoryName, `story-${input.storyId}-${slug}`];
  return platform === "win32" && input.mode === "cloud-mirror"
    ? win32.join(...parts)
    : posix.join(...parts);
}

export function storyBranch(storyId: string, title: string) {
  return `blame/story-${storyId}-${storySlug(storyId, title)}`;
}

export function storySlug(storyId: string, title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `story-${storyId}`;
}

export function runtimeManagedPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "darwin" && platform !== "win32") return false;
  if (platform === "darwin") return macosRuntimeManagedPath(path);
  return (
    normalizedRuntimePath(path) === vmRuntimeWorktreeRoot ||
    normalizedRuntimePath(path).startsWith(`${vmRuntimeWorktreeRoot}/`)
  );
}

export function runtimeVmInternalPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "darwin" && platform !== "win32") return false;
  const normalized = normalizedRuntimePath(path);
  return (
    normalized === vmRuntimeWorktreeRoot ||
    normalized.startsWith(`${vmRuntimeWorktreeRoot}/`)
  );
}

export function resolveWorkspacePath(path: string) {
  if (runtimePathLike(path)) return normalizedRuntimePath(path);
  return resolve(path);
}

export function joinWorkspacePath(root: string, ...paths: string[]) {
  if (runtimePathLike(root))
    return posix.join(normalizedRuntimePath(root), ...paths);
  return joinHostPath(root, ...paths);
}

export function dirnameWorkspacePath(path: string) {
  if (runtimePathLike(path)) return posix.dirname(normalizedRuntimePath(path));
  return dirname(path);
}

export function runtimeAccessiblePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
) {
  return runtimeCwdPath(path, platform);
}

export function runtimeHostPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (platform !== "win32" || !runtimeManagedPath(path, platform)) return path;
  const normalized = normalizedRuntimePath(path).replace(/^\/+/, "");
  return `\\\\wsl.localhost\\${runtimeDistroName(env)}\\${normalized.replace(/\//g, "\\")}`;
}

export function runtimeCommand(
  command: string,
  args: string[],
  input: RuntimeOptions = {},
): RuntimeCommandSpec {
  const platform = input.platform ?? process.platform;
  if (input.execution === "native") return { args, command, cwd: input.cwd };
  if (platform === "darwin")
    return runtimeWrappedCommand(
      "blame-lima-runtime",
      command,
      args,
      input.cwd,
      platform,
      input.user,
    );
  if (platform === "win32")
    return runtimeWrappedCommand(
      "blame-wsl2-runtime",
      command,
      args,
      input.cwd,
      platform,
      input.user,
    );
  return { args, command, cwd: input.cwd };
}

export async function run(
  command: string,
  args: string[],
  input: RuntimeOptions = {},
) {
  const platform = input.platform ?? process.platform;
  const execution = runtimeExecution(input, platform, runtimeManagedPath);
  let env = runtimeEnvironment(input, platform);
  const useAgent =
    execution === "virtualized" && useRuntimeAgent(platform, env);
  if (command === "git" && useAgent) {
    const { name, email } = getRuntimeGitIdentity();
    env = {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND:
        platform === "win32"
          ? "ssh.exe -o BatchMode=yes -o StrictHostKeyChecking=no"
          : "ssh -o BatchMode=yes -o StrictHostKeyChecking=no",
      ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}),
      ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {}),
    };
  }
  if (useAgent) {
    try {
      return await runtimeAgentClient({ env, platform }).exec({
        args,
        command,
        cwd: input.cwd ? runtimeCwdPath(input.cwd, platform) : undefined,
        env,
        user: input.user ?? "blame",
      });
    } catch (error) {
      if (runtimeAgentCommandFailed(error)) throw error;
    }
  }
  const spec = runtimeCommand(command, args, { ...input, execution });
  const commandSpec = runtimeExecutableCommand(spec, platform, env);
  const result = await execFileAsync(commandSpec.command, commandSpec.args, {
    cwd: spec.cwd,
    env,
    maxBuffer: input.maxBuffer,
    shell: false,
    windowsVerbatimArguments: commandSpec.windowsVerbatimArguments,
  });
  return {
    stderr: String(result.stderr),
    stdout: String(result.stdout),
  };
}

export function spawnRuntime(
  command: string,
  args: string[],
  input: RuntimeOptions = {},
): ChildProcessWithoutNullStreams {
  const platform = input.platform ?? process.platform;
  const execution = runtimeExecution(input, platform, runtimeManagedPath);
  const env = runtimeEnvironment(input, platform);
  if (execution === "virtualized" && useRuntimeAgent(platform, env)) {
    return runtimeAgentClient({ env, platform }).spawn({
      args,
      command,
      cwd: input.cwd ? runtimeCwdPath(input.cwd, platform) : undefined,
      env,
      user: input.user ?? "blame",
    });
  }
  const spec = runtimeCommand(command, args, { ...input, execution });
  const commandSpec = runtimeExecutableCommand(spec, platform, env);
  return spawn(commandSpec.command, commandSpec.args, {
    cwd: spec.cwd,
    detached: platform !== "win32",
    env,
    shell: false,
    windowsVerbatimArguments: commandSpec.windowsVerbatimArguments,
  });
}

export async function pathExists(path: string, input: RuntimeOptions = {}) {
  if (!runtimeManagedPath(path, input.platform)) return existsSync(path);
  try {
    await run("test", ["-e", path], input);
    return true;
  } catch {
    return false;
  }
}

export async function mkdir(path: string, input: RuntimeOptions = {}) {
  if (!runtimeManagedPath(path, input.platform)) {
    await mkdirHost(path, { recursive: true });
    return;
  }
  await run("mkdir", ["-p", path], input);
}

export async function rm(path: string, input: RuntimeOptions = {}) {
  if (!runtimeManagedPath(path, input.platform)) {
    await rmHost(path, {
      force: true,
      recursive: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    return;
  }
  await run("rm", ["-rf", path], { ...input, user: "root" });
}

export async function readFile(path: string, input: RuntimeOptions = {}) {
  if (!runtimeManagedPath(path, input.platform))
    return readHostFile(path, "utf8");
  const { stdout } = await run("cat", [path], input);
  return stdout;
}

export async function readExistingFiles(
  paths: string[],
  input: RuntimeOptions = {},
) {
  const platform = input.platform ?? process.platform;
  const env = runtimeEnvironment(input, platform);
  if (
    paths.every((path) => runtimeManagedPath(path, platform)) &&
    useRuntimeAgent(platform, env)
  ) {
    try {
      return (
        await runtimeAgentClient({ env, platform }).readExistingFiles(paths)
      ).files;
    } catch (error) {
      if (runtimeAgentCommandFailed(error)) throw error;
    }
  }
  const entries = await Promise.all(
    paths.map(async (path) => {
      if (!(await pathExists(path, input))) return [path, null] as const;
      return [path, await readFile(path, input)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function readDirectory(path: string, input: RuntimeOptions = {}) {
  const { stdout } = await run(
    "find",
    [path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\t%y\n"],
    input,
  );
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, type] = line.split("\t", 2);
      return {
        isDirectory: () => type === "d",
        isFile: () => type === "f",
        isSymbolicLink: () => type === "l",
        name,
      };
    });
}

export async function findProjectFilesByName(
  root: string,
  name: string,
  fns: {
    run: (command: string, args: string[]) => Promise<{ stdout: string }>;
  } = { run },
) {
  if (!name || name.includes("/") || name.includes("\\")) return [];
  try {
    const { stdout } = await fns.run(
      "find",
      projectFileSearchArguments(root, name),
    );
    return [...new Set(stdout.split("\n").filter(Boolean))].slice(
      0,
      maxProjectFileSearchResults,
    );
  } catch {
    return [];
  }
}

function projectFileSearchArguments(root: string, name: string) {
  const ignoredNames = ignoredProjectSearchDirectories.flatMap(
    (directory, index) =>
      index ? ["-o", "-name", directory] : ["-name", directory],
  );
  return [
    root,
    "-type",
    "d",
    "(",
    ...ignoredNames,
    ")",
    "-prune",
    "-o",
    "-type",
    "f",
    "-name",
    name,
    "-print",
  ];
}

export async function writeFile(
  path: string,
  data: string,
  input: RuntimeOptions = {},
) {
  if (!runtimeManagedPath(path, input.platform)) {
    await writeHostFile(path, data, "utf8");
    return;
  }
  await mkdir(dirname(path), input);
  const encoded = Buffer.from(data, "utf8").toString("base64");
  await run(
    "sh",
    [
      "-lc",
      `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)}`,
    ],
    input,
  );
}

export async function writeFileAtomic(
  path: string,
  data: string,
  input: RuntimeOptions = {},
) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, data, input);
    if (runtimeManagedPath(path, input.platform)) {
      await run("mv", ["--", temporaryPath, path], input);
      return;
    }
    await renameHost(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, input).catch(() => undefined);
    throw error;
  }
}

export async function appendFile(
  path: string,
  data: string,
  input: RuntimeOptions = {},
) {
  if (!runtimeManagedPath(path, input.platform)) {
    await appendHostFile(path, data, "utf8");
    return;
  }
  await mkdir(dirname(path), input);
  const encoded = Buffer.from(data, "utf8").toString("base64");
  await run(
    "sh",
    [
      "-lc",
      `printf %s ${shellQuote(encoded)} | base64 -d >> ${shellQuote(path)}`,
    ],
    input,
  );
}

export async function chmod(
  path: string,
  mode: number,
  input: RuntimeOptions = {},
) {
  if (!runtimeManagedPath(path, input.platform)) {
    await chmodHost(path, mode);
    return;
  }
  await run("chmod", [mode.toString(8), path], input);
}

function runtimeWrappedCommand(
  wrapper: string,
  command: string,
  args: string[],
  cwd?: string,
  platform: NodeJS.Platform = process.platform,
  user: RuntimeOptions["user"] = "blame",
): RuntimeCommandSpec {
  const commandArgs =
    user === "root" ? ["root", command, ...args] : [command, ...args];
  if (!cwd) return { args: commandArgs, command: wrapper };
  const runtimeCwd = runtimeCwdPath(cwd, platform);
  const script = `cd ${shellQuote(runtimeCwd)} && exec ${shellQuote(command)} ${args.map(shellQuote).join(" ")}`;
  return {
    args:
      user === "root" ? ["root", "sh", "-lc", script] : ["sh", "-lc", script],
    command: wrapper,
  };
}

function runtimeCwdPath(path: string, platform: NodeJS.Platform) {
  if (platform !== "win32" || runtimePathLike(path)) return path;
  return windowsPathToWslPath(path) ?? path;
}

function windowsPathToWslPath(path: string) {
  const normalized = path.replace(/\//g, "\\");
  const match = normalized.match(/^([a-zA-Z]):\\?(.*)$/);
  if (!match) return undefined;
  const drive = match[1].toLowerCase();
  const rest = match[2].split("\\").filter(Boolean).map(encodeWslSegment);
  return posix.join("/mnt", drive, ...rest);
}

function encodeWslSegment(value: string) {
  return value;
}

function runtimeEnvironment(input: RuntimeOptions, platform: NodeJS.Platform) {
  const env = withoutTelemetryEnvironment(
    input.env ?? {
      ...process.env,
      PATH: setupPath({ platform }),
    },
  );
  if (platform === "win32") {
    const wslenv =
      "GIT_SSH_COMMAND/u:GIT_TERMINAL_PROMPT/u:GIT_AUTHOR_NAME/u:GIT_AUTHOR_EMAIL/u:GIT_COMMITTER_NAME/u:GIT_COMMITTER_EMAIL/u";
    return {
      ...env,
      WSLENV: env.WSLENV ? `${env.WSLENV}:${wslenv}` : wslenv,
    };
  }
  return env;
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

export function runtimeExecutableCommand(
  spec: RuntimeCommandSpec,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): RuntimeCommandSpec {
  // Only native Git keeps the bare "git" command: runtime commands are wrapped.
  if (spec.command === "git")
    return { ...spec, command: hostGitCommand({ env, platform }) };
  if (platform !== "win32") return spec;
  const script = runtimeToolScript(spec.command, { env, platform });
  if (script) {
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
  return {
    args: ["/d", "/s", "/c", commandPromptLine(spec.command, spec.args, env)],
    command: "cmd.exe",
    windowsVerbatimArguments: true,
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

function repositoryBasename(path: string, platform: NodeJS.Platform) {
  if (platform === "win32") return win32.basename(path);
  return basename(path);
}

function joinHostPath(root: string, ...paths: string[]) {
  return join(root, ...paths);
}

function macosRuntimeManagedPath(path: string) {
  const normalized = normalizedRuntimePath(path);
  return (
    normalized === vmRuntimeWorktreeRoot ||
    normalized.startsWith(`${vmRuntimeWorktreeRoot}/`) ||
    normalized.endsWith(macosRuntimeWorktreeSegment) ||
    normalized.includes(`${macosRuntimeWorktreeSegment}/`)
  );
}

function runtimePathLike(path: string) {
  const normalized = normalizedRuntimePath(path);
  return (
    normalized === vmRuntimeWorktreeRoot ||
    normalized.startsWith(`${vmRuntimeWorktreeRoot}/`) ||
    normalized.endsWith(macosRuntimeWorktreeSegment) ||
    normalized.includes(`${macosRuntimeWorktreeSegment}/`) ||
    normalized.includes("/.local/share/blame/runtime/worktrees/")
  );
}

function normalizedRuntimePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

let runtimeGitIdentityConfigured = false;
let resolvedGitName = "";
let resolvedGitEmail = "";

export function getRuntimeGitIdentity() {
  return { name: resolvedGitName, email: resolvedGitEmail };
}

export function resetRuntimeGitIdentityConfigured() {
  runtimeGitIdentityConfigured = false;
  resolvedGitName = "";
  resolvedGitEmail = "";
}

export const resetRuntimeGitIdentityConfiguredForTesting =
  resetRuntimeGitIdentityConfigured;

// Reads the identity from this machine's Git, then sets it inside the runtime.
async function hostGitExecFile(command: string, args: string[]) {
  return execFileAsync(command === "git" ? hostGitCommand() : command, args);
}

type RuntimeGitIdentityDeps = {
  execFileAsync: typeof hostGitExecFile;
  platform?: NodeJS.Platform;
  run: typeof run;
};

// Only macOS and Windows run Git inside the runtime VM. Elsewhere the same
// command would write to the user's own ~/.gitconfig, so leave it alone: the
// Git identity dialog asks for a missing name or email instead.
export async function ensureRuntimeGitUserIdentity(
  fns: RuntimeGitIdentityDeps = { execFileAsync: hostGitExecFile, run },
) {
  if (runtimeGitIdentityConfigured) return;
  const platform = fns.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") return;
  try {
    let name = "";
    let email = "";
    try {
      const { stdout } = await fns.execFileAsync("git", [
        "config",
        "--global",
        "user.name",
      ]);
      name = stdout.trim();
    } catch (err) {
      log.warn(
        "ensureRuntimeGitUserIdentity: failed to read host global user.name:",
        err,
      );
    }
    if (!name) {
      try {
        const { stdout } = await fns.execFileAsync("git", [
          "config",
          "user.name",
        ]);
        name = stdout.trim();
      } catch (err) {
        log.warn(
          "ensureRuntimeGitUserIdentity: failed to read host local user.name:",
          err,
        );
      }
    }
    if (!name) {
      name =
        process.env.GIT_AUTHOR_NAME ||
        process.env.GIT_COMMITTER_NAME ||
        process.env.USER ||
        process.env.USERNAME ||
        "Blame User";
    }

    try {
      const { stdout } = await fns.execFileAsync("git", [
        "config",
        "--global",
        "user.email",
      ]);
      email = stdout.trim();
    } catch (err) {
      log.warn(
        "ensureRuntimeGitUserIdentity: failed to read host global user.email:",
        err,
      );
    }
    if (!email) {
      try {
        const { stdout } = await fns.execFileAsync("git", [
          "config",
          "user.email",
        ]);
        email = stdout.trim();
      } catch (err) {
        log.warn(
          "ensureRuntimeGitUserIdentity: failed to read host local user.email:",
          err,
        );
      }
    }
    if (!email) {
      email =
        process.env.GIT_AUTHOR_EMAIL ||
        process.env.GIT_COMMITTER_EMAIL ||
        "blame@example.local";
    }

    log.info(
      `ensureRuntimeGitUserIdentity: configuring VM git identity: ${name} <${email}>`,
    );
    await fns.run("git", ["config", "--global", "user.name", name]);
    await fns.run("git", ["config", "--global", "user.email", email]);

    resolvedGitName = name;
    resolvedGitEmail = email;
    runtimeGitIdentityConfigured = true;
    log.info(
      "ensureRuntimeGitUserIdentity: VM git identity configured successfully.",
    );
  } catch (err) {
    log.error(
      "ensureRuntimeGitUserIdentity: failed to configure VM git identity:",
      err,
    );
  }
}
