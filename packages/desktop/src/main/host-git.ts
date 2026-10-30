import { existsSync, readdirSync } from "node:fs";
import { posix, win32 } from "node:path";

// Every Git command Blame runs on this machine (not inside BlameRuntime)
// starts from hostGitCommand(). On Windows it returns git.exe's full path, so
// Git is spawned directly: never through cmd.exe, whose argument parsing
// differs from Node's and whose errors come out in the system locale.

export const hostGitMissingErrorCode = "BLAME_GIT_MISSING";

export class HostGitMissingError extends Error {
  readonly code = hostGitMissingErrorCode;

  constructor(platform: NodeJS.Platform = process.platform) {
    super(hostGitMissingMessage(platform));
    this.name = "HostGitMissingError";
  }
}

export function hostGitMissingMessage(
  platform: NodeJS.Platform = process.platform,
) {
  if (platform === "win32")
    return "Git is not installed on this computer, or Blame cannot find git.exe. Install Git for Windows from https://git-scm.com/download/win (or run: winget install --id Git.Git -e), then try again.";
  if (platform === "darwin")
    return "Git is not installed on this Mac. Install the Xcode Command Line Tools (run: xcode-select --install) or Git from Homebrew (run: brew install git), then try again.";
  return "Git is not installed on this computer. Install git with your system package manager (for example: sudo apt install git), then try again.";
}

export type HostGitInput = {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  listDirectory?: (path: string) => string[];
  platform?: NodeJS.Platform;
};

const resolvedCommands = new Map<string, string>();

export function hostGitCommand(input: HostGitInput = {}) {
  const platform = input.platform ?? process.platform;
  const command = findHostGit(input);
  if (!command) throw new HostGitMissingError(platform);
  return command;
}

export function findHostGit(input: HostGitInput = {}) {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const exists = input.exists ?? existsSync;
  const override = envValue(env, "BLAME_GIT_PATH", platform);
  if (override && exists(override)) return override;
  const searchPath = envValue(env, "PATH", platform) ?? "";
  const key = `${platform}\0${searchPath}`;
  const cached = resolvedCommands.get(key);
  if (cached && (cached === "git" || exists(cached))) return cached;
  const command =
    platform === "win32"
      ? findWindowsGit(env, searchPath, exists, input.listDirectory)
      : findPosixGit(searchPath, exists);
  // Misses are not cached: installing Git must work without restarting Blame.
  if (command) resolvedCommands.set(key, command);
  else resolvedCommands.delete(key);
  return command;
}

export function isHostGitMissingError(error: unknown) {
  return (
    error instanceof HostGitMissingError ||
    Boolean(
      error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === hostGitMissingErrorCode,
    )
  );
}

function findWindowsGit(
  env: NodeJS.ProcessEnv,
  searchPath: string,
  exists: (path: string) => boolean,
  listDirectory: (path: string) => string[] = listDirectoryNames,
) {
  const onPath = pathEntries(searchPath, ";").map((entry) =>
    win32.join(entry, "git.exe"),
  );
  return [...onPath, ...windowsGitInstallPaths(env, listDirectory)].find(
    (candidate) => exists(candidate),
  );
}

// Git for Windows can be installed without adding itself to PATH, and a PATH
// change made after Explorer started does not reach apps launched from the
// Start menu. Look where the usual installers put git.exe.
function windowsGitInstallPaths(
  env: NodeJS.ProcessEnv,
  listDirectory: (path: string) => string[],
) {
  const value = (name: string) => envValue(env, name, "win32");
  const programRoots = unique([
    value("ProgramW6432"),
    value("ProgramFiles"),
    value("ProgramFiles(x86)"),
    String.raw`C:\Program Files`,
  ]);
  const localAppData = value("LOCALAPPDATA");
  const userProfile = value("USERPROFILE");
  const scoop = value("SCOOP");
  return [
    ...programRoots.flatMap((root) => [
      win32.join(root, "Git", "cmd", "git.exe"),
      win32.join(root, "Git", "bin", "git.exe"),
    ]),
    localAppData &&
      win32.join(localAppData, "Programs", "Git", "cmd", "git.exe"),
    scoop && win32.join(scoop, "shims", "git.exe"),
    userProfile && win32.join(userProfile, "scoop", "shims", "git.exe"),
    ...(localAppData ? gitHubDesktopGitPaths(localAppData, listDirectory) : []),
  ].filter((path): path is string => Boolean(path));
}

function gitHubDesktopGitPaths(
  localAppData: string,
  listDirectory: (path: string) => string[],
) {
  const root = win32.join(localAppData, "GitHubDesktop");
  return listDirectory(root)
    .filter((name) => name.startsWith("app-"))
    .sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }),
    )
    .map((name) =>
      win32.join(root, name, "resources", "app", "git", "cmd", "git.exe"),
    );
}

function findPosixGit(searchPath: string, exists: (path: string) => boolean) {
  // Found on PATH: let the system resolve it exactly as before.
  if (
    pathEntries(searchPath, ":").some((entry) =>
      exists(posix.join(entry, "git")),
    )
  )
    return "git";
  return ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/bin"]
    .map((directory) => posix.join(directory, "git"))
    .find((candidate) => exists(candidate));
}

function pathEntries(value: string, separator: string) {
  return value
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

// Windows variable names are case-insensitive, but a copied environment keeps
// the original spelling ("Path"). Pick the key a child process would get.
function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
) {
  if (platform !== "win32") return env[name] || undefined;
  const upper = name.toUpperCase();
  const key = Object.keys(env)
    .sort()
    .find((candidate) => candidate.toUpperCase() === upper);
  return (key && env[key]) || undefined;
}

function listDirectoryNames(path: string) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function unique(values: Array<string | undefined>) {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}
