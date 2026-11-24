import { existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, join, win32 } from "node:path";

type SetupPathInput = {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
};

export function setupPath(input: SetupPathInput = {}) {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const execPath = input.execPath ?? process.execPath;
  const execDir = dirnameForPlatform(execPath, platform);
  return uniquePaths(
    [
      execDir,
      ...runtimeToolPaths(env, execDir, platform),
      ...windowsRuntimeToolPaths(env, execDir, platform),
      ...windowsPackageManagerPaths(env, platform),
      ...nodeVersionManagerPaths(env),
      env.PATH,
    ],
    platform,
  ).join(pathDelimiter(platform));
}

/**
 * The environment the runtime commands (`blame-lima-runtime`,
 * `blame-wsl2-runtime`) run under: the packaged app's PATH lacks the folder
 * that holds them, and a status check without it reports the runtime missing.
 */
export function runtimeToolEnvironment(
  input: SetupPathInput = {},
): NodeJS.ProcessEnv {
  return { ...(input.env ?? process.env), PATH: setupPath(input) };
}

export function runtimeToolCommand(
  command: string,
  input: SetupPathInput = {},
) {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const execPath = input.execPath ?? process.execPath;
  const execDir = dirnameForPlatform(execPath, platform);
  if (platform === "win32") {
    const file = command.endsWith(".cmd") ? command : `${command}.cmd`;
    return (
      windowsRuntimeToolPaths(env, execDir, platform)
        .filter((path): path is string => Boolean(path))
        .map((path) => win32.join(path, file))
        .find((path) => existsSync(path)) ?? file
    );
  }
  return command;
}

export function runtimeToolScript(command: string, input: SetupPathInput = {}) {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const execPath = input.execPath ?? process.execPath;
  const execDir = dirnameForPlatform(execPath, platform);
  const file = `${command.replace(/\.cmd$/i, "")}.ps1`;
  return windowsRuntimeScriptPaths(env, execDir, platform)
    .filter((path): path is string => Boolean(path))
    .map((path) => win32.join(path, file))
    .find((path) => existsSync(path));
}

function runtimeToolPaths(
  env: NodeJS.ProcessEnv,
  execDir: string,
  platform: NodeJS.Platform,
) {
  if (platform !== "darwin") return [];
  return [
    env.BLAME_RUNTIME_BIN_DIR,
    join(dirname(execDir), "Resources", "runtime", "macos", "bin"),
    join(execDir, "resources", "runtime", "macos", "bin"),
    join(execDir, "runtime", "macos", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
}

function windowsRuntimeScriptPaths(
  env: NodeJS.ProcessEnv,
  execDir: string,
  platform: NodeJS.Platform,
) {
  if (platform !== "win32") return [];
  return [
    env.BLAME_RUNTIME_SCRIPT_DIR,
    win32.join(execDir, "resources", "runtime", "windows", "scripts"),
    win32.join(execDir, "runtime", "windows", "scripts"),
  ];
}

function windowsRuntimeToolPaths(
  env: NodeJS.ProcessEnv,
  execDir: string,
  platform: NodeJS.Platform,
) {
  if (platform !== "win32") return [];
  return [
    env.BLAME_RUNTIME_BIN_DIR,
    win32.join(execDir, "resources", "runtime", "windows", "bin"),
    win32.join(execDir, "runtime", "windows", "bin"),
  ];
}

function dirnameForPlatform(path: string, platform: NodeJS.Platform) {
  return platform === "win32" ? win32.dirname(path) : dirname(path);
}

function windowsPackageManagerPaths(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  if (platform !== "win32") return [];
  return [
    env.APPDATA ? win32.join(env.APPDATA, "npm") : undefined,
    env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "pnpm") : undefined,
    env.ProgramFiles ? win32.join(env.ProgramFiles, "nodejs") : undefined,
    env["ProgramFiles(x86)"]
      ? win32.join(env["ProgramFiles(x86)"], "nodejs")
      : undefined,
  ];
}

function nodeVersionManagerPaths(env: NodeJS.ProcessEnv) {
  return [
    ...nodeVersionBins(join(homePath(env), ".nvm", "versions", "node")),
    ...nodeVersionBins(
      join(homePath(env), ".local", "share", "fnm", "node-versions"),
    ),
    join(homePath(env), ".local", "bin"),
    join(homePath(env), ".bun", "bin"),
  ];
}

function nodeVersionBins(root: string) {
  try {
    return readdirSync(root)
      .map((entry) => join(root, entry, "bin"))
      .filter((path) => existsSync(path));
  } catch {
    return [];
  }
}

function homePath(env: NodeJS.ProcessEnv) {
  return env.HOME || env.USERPROFILE || "";
}

function uniquePaths(
  paths: Array<string | undefined>,
  platform: NodeJS.Platform,
) {
  const separator = pathDelimiter(platform);
  return Array.from(
    new Set(paths.flatMap((path) => (path ? path.split(separator) : []))),
  ).filter(Boolean);
}

function pathDelimiter(platform: NodeJS.Platform) {
  return platform === "win32" ? ";" : delimiter;
}
