import type { RuntimeProfileId } from "@blame/preview-runtime";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

// direct: the story runs in the project folder itself (no worktree, no
// container, no managed preview).
export type WorkspaceMode = "local-container" | "cloud-mirror" | "direct";
export type WorkspaceExecution = "native" | "virtualized";

export function runtimeExecution(
  input: { cwd?: string; execution?: WorkspaceExecution },
  platform: NodeJS.Platform,
  runtimeManagedPath: (path: string, platform: NodeJS.Platform) => boolean,
): WorkspaceExecution {
  if (input.execution) return input.execution;
  if (platform !== "darwin" && platform !== "win32") return "native";
  if (input.cwd && !runtimeManagedPath(input.cwd, platform)) return "native";
  return "virtualized";
}

export function workspaceMode(profile: RuntimeProfileId): WorkspaceMode {
  return profile === "local-container" ? "local-container" : "cloud-mirror";
}

export function workspaceExecution(mode: WorkspaceMode): WorkspaceExecution {
  return mode === "local-container" ? "virtualized" : "native";
}

export function platformWorktreeRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  mode: WorkspaceMode,
) {
  if (mode === "cloud-mirror") return nativeCloudWorktreeRoot(platform, env);
  if (platform === "darwin" || platform === "win32")
    return "/home/blame/.local/share/blame/runtime/worktrees";
  const home = env.HOME || homedir() || "/home/blame";
  return posix.join(
    home.replace(/\\/g, "/"),
    ".local",
    "share",
    "blame",
    "runtime",
    "worktrees",
  );
}

function nativeCloudWorktreeRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) {
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA ||
      win32.join(env.USERPROFILE || homedir(), "AppData", "Local");
    return win32.join(localAppData, "Blame", "cloud", "worktrees");
  }
  const home = env.HOME || homedir() || "/home/blame";
  if (platform === "darwin")
    return join(
      home,
      "Library",
      "Application Support",
      "Blame",
      "cloud",
      "worktrees",
    );
  return posix.join(
    home.replace(/\\/g, "/"),
    ".local",
    "share",
    "blame",
    "cloud",
    "worktrees",
  );
}
