import {
  ensureRuntimeGitUserIdentity,
  run as runRuntime,
  runtimeAccessiblePath,
  runtimeManagedPath,
} from "./workspace-runtime.ts";
import {
  workspaceExecution,
  type WorkspaceExecution,
  type WorkspaceMode,
} from "./workspace-mode.ts";

export async function branchExists(
  cwd: string,
  branch: string,
  mode?: WorkspaceMode,
) {
  try {
    await runRuntimeGit(
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      mode ? workspaceExecution(mode) : undefined,
    );
    return true;
  } catch {
    return false;
  }
}

export async function worktreeRegistered(
  cwd: string,
  worktree: string,
  mode?: WorkspaceMode,
) {
  const { stdout } = await runRuntimeGit(
    cwd,
    ["worktree", "list", "--porcelain"],
    mode ? workspaceExecution(mode) : undefined,
  );
  return stdout.split("\n").some((line) => worktreeLineMatches(line, worktree));
}

// Worktrees Git already trusts in the runtime. Should its configuration
// lose one, the dubious ownership retry in runRuntimeGit adds it again.
const safeDirectories = new Set<string>();

export async function ensureRuntimeGitSafeDirectory(cwd: string) {
  if (process.platform !== "win32") return;
  const safeDirectory = runtimeGitSafeDirectory(cwd);
  if (safeDirectories.has(safeDirectory)) return;
  const stdout = await configuredSafeDirectories();
  if (!safeDirectoryConfigured(stdout, safeDirectory))
    await addRuntimeGitSafeDirectory(cwd);
  safeDirectories.add(safeDirectory);
}

export async function runRuntimeGit(
  cwd: string,
  args: string[],
  execution: WorkspaceExecution = runtimeManagedPath(cwd)
    ? "virtualized"
    : "native",
) {
  if (execution === "virtualized") {
    await ensureRuntimeGitSafeDirectory(cwd);
    await ensureRuntimeGitUserIdentity();
  }
  try {
    return await runRuntime("git", args, { cwd, execution });
  } catch (error) {
    if (execution !== "virtualized" || !dubiousOwnershipError(error))
      throw error;
    await addRuntimeGitSafeDirectory(cwd);
    return runRuntime("git", args, { cwd, execution });
  }
}

async function addRuntimeGitSafeDirectory(cwd: string) {
  await runRuntime("git", [
    "config",
    "--global",
    "--add",
    "safe.directory",
    runtimeGitSafeDirectory(cwd),
  ]);
}

function runtimeGitSafeDirectory(cwd: string) {
  return process.platform === "win32"
    ? runtimeAccessiblePath(cwd, "win32")
    : cwd;
}

function dubiousOwnershipError(error: unknown) {
  return errorText(error).includes("detected dubious ownership");
}

async function configuredSafeDirectories() {
  try {
    const { stdout } = await runRuntime("git", [
      "config",
      "--global",
      "--get-all",
      "safe.directory",
    ]);
    return stdout;
  } catch {
    return "";
  }
}

function safeDirectoryConfigured(stdout: string, safeDirectory: string) {
  return stdout
    .split("\n")
    .map((line) => normalizedPath(line.trim()))
    .includes(normalizedPath(safeDirectory));
}

function worktreeLineMatches(line: string, worktree: string) {
  return (
    line.startsWith("worktree ") &&
    normalizedPath(line.slice("worktree ".length).trim()) ===
      normalizedPath(worktree)
  );
}

function errorText(error: unknown) {
  if (!error || typeof error !== "object")
    return error instanceof Error ? error.message : "";
  const record = error as Record<string, unknown>;
  return [
    error instanceof Error ? error.message : "",
    record.stdout,
    record.stderr,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function normalizedPath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}
