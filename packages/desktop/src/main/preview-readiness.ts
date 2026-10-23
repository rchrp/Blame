import { createHash } from "node:crypto";

export type PreviewContainerFailure =
  | "preview_container_missing"
  | "preview_container_stopped";

type PreviewContainerState = {
  discoveryGraceMs: number;
  elapsedMs: number;
  found: boolean;
  health?: string;
  status?: string;
};

export function previewContainerFailure(
  state: PreviewContainerState,
): PreviewContainerFailure | undefined {
  if (!state.found) {
    return state.elapsedMs < state.discoveryGraceMs
      ? undefined
      : "preview_container_missing";
  }
  if (state.health === "unhealthy" || failedContainerStatus(state.status)) {
    return "preview_container_stopped";
  }
  return undefined;
}

function failedContainerStatus(status: string | undefined) {
  return status === "dead" || status === "exited" || status === "removing";
}

export function previewComposeProjectName(worktree: string) {
  return `blame_${createHash("sha1").update(worktree).digest("hex").slice(0, 12)}`;
}

export function containerMatchesWorktree(
  container: { Config?: { Labels?: Record<string, string> } },
  worktree: string,
) {
  const labels = container.Config?.Labels ?? {};
  const normalizedWorktree = runtimeLabelPath(worktree);
  if (!normalizedWorktree) return false;
  // nerdctl Compose only emits the project and service labels.
  return (
    labels["com.docker.compose.project"] ===
      previewComposeProjectName(worktree) ||
    runtimeLabelPath(labels["com.docker.compose.project.working_dir"] ?? "") ===
      normalizedWorktree ||
    Boolean(
      labels["com.docker.compose.project.config_files"]
        ?.split(",")
        .some((file) =>
          runtimeLabelPath(file).startsWith(`${normalizedWorktree}/`),
        ),
    )
  );
}

function runtimeLabelPath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

const previewLogNoise = [
  /^Preparing \S+ for immediate activation/,
  /^> \S+@\S+ \S+/,
  /^> /,
  /^(?:\S+\s+)?ELIFECYCLE\b/,
  /^npm (?:ERR!|error) (?:code|path|command|errno|signal|A complete log)/,
  /^error Command failed with exit code/,
  /^info Visit https:\/\/yarnpkg\.com/,
  /^time="[^"]*" level=/,
];

// Keeps the last lines a failed preview printed, without Compose prefixes or
// package manager boilerplate, so the error says why the container stopped.
export function previewFailureLogExcerpt(logs: string, maxLines = 3) {
  const lines = logs
    .split(/\r?\n/)
    .map((line) => line.replace(/^\S+-\d+\s*\|\s?/, "").trim())
    .filter(Boolean)
    .filter((line) => !previewLogNoise.some((pattern) => pattern.test(line)));
  const excerpt = lines.slice(-maxLines).join(" ");
  return excerpt.length > 400 ? `${excerpt.slice(0, 399)}…` : excerpt;
}
