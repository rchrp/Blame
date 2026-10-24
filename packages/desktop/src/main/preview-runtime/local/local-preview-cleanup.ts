import type { DockerHost } from "@blame/preview-runtime/compose";
import { blameRuntimeDockerHost } from "./vm-docker-host.ts";

// Keeps the Blame Runtime small. A preview's containers, network and own
// volumes go with its worktree; shared node_modules volumes go once no
// worktree uses them; images built over two weeks ago that no container
// uses are pruned. Database volumes of existing worktrees are never
// touched. The desktop never runs this while a preview starts.

/** Removes everything Docker keeps for one preview project. */
export async function removePreviewProject(
  projectName: string,
  host: DockerHost = blameRuntimeDockerHost,
) {
  if (!/^blame_[0-9a-f]{12}$/.test(projectName)) return false;
  const result = await host.run("sh", [
    "-c",
    removeProjectScript,
    "sh",
    projectName,
  ]);
  return result.exitCode === 0;
}

/**
 * Removes the previews of deleted worktrees and the volumes and images
 * nothing uses any more. Returns the names of the removed projects.
 */
export async function collectPreviewGarbage(
  worktreeRoots: string[],
  host: DockerHost = blameRuntimeDockerHost,
) {
  const result = await host.run(
    "sh",
    ["-c", collectGarbageScript, "sh", ...worktreeRoots],
    { timeoutMs: 10 * 60_000 },
  );
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("removed "))
    .map((line) => line.slice("removed ".length));
}

/** The worktrees whose preview has a running service container. */
export async function runningPreviewWorktrees(
  host: DockerHost = blameRuntimeDockerHost,
) {
  const result = await host.run("docker", [
    "ps",
    "--filter",
    "label=blame.preview",
    "--filter",
    "label=com.docker.compose.oneoff=False",
    "--format",
    '{{.Label "com.docker.compose.project.working_dir"}}',
  ]);
  if (result.exitCode !== 0) return [];
  const suffix = "/.blame/preview";
  return [
    ...new Set(
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.endsWith(suffix))
        .map((line) => line.slice(0, -suffix.length)),
    ),
  ];
}

const removeProjectScript = `
project="$1"
label="label=com.docker.compose.project=$project"
containers="$(docker ps -aq --filter "$label")"
[ -z "$containers" ] || docker rm -f $containers >/dev/null
networks="$(docker network ls -q --filter "$label")"
[ -z "$networks" ] || docker network rm $networks >/dev/null 2>&1 || true
volumes="$(docker volume ls -q --filter "name=^\${project}_")"
[ -z "$volumes" ] || docker volume rm -f $volumes >/dev/null
`;

const collectGarbageScript = `
set -u
live="$(for root in "$@"; do
  find "$root" -mindepth 1 -maxdepth 3 -name .git 2>/dev/null
done | while IFS= read -r git; do
  printf 'blame_%s\\n' "$(printf '%s' "\${git%/.git}" | sha1sum | cut -c1-12)"
done)"
alive() { printf '%s\\n' "$live" | grep -qx "$1"; }
for project in $( (docker ps -a --format '{{.Label "com.docker.compose.project"}}'; docker volume ls -q) |
  sed -n 's/^\\(blame_[0-9a-f]\\{12\\}\\)\\($\\|_.*\\)/\\1/p' | sort -u); do
  alive "$project" && continue
  containers="$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
  [ -z "$containers" ] || docker rm -f $containers >/dev/null
  networks="$(docker network ls -q --filter "label=com.docker.compose.project=$project")"
  [ -z "$networks" ] || docker network rm $networks >/dev/null 2>&1 || true
  volumes="$(docker volume ls -q --filter "name=^\${project}_")"
  [ -z "$volumes" ] || docker volume rm -f $volumes >/dev/null
  echo "removed $project"
done
referenced="$(for root in "$@"; do
  find "$root" -mindepth 3 -maxdepth 6 -path '*/.blame/preview/compose.yaml' 2>/dev/null
done | xargs -r cat 2>/dev/null | sed -n 's/^ *name: \\(blame_node_modules_[A-Za-z0-9_]*\\)$/\\1/p' | sort -u)"
for volume in $(docker volume ls -q --filter dangling=true --filter name=blame_node_modules_); do
  printf '%s\\n' "$referenced" | grep -qx "$volume" || docker volume rm "$volume" >/dev/null 2>&1 || true
done
docker image prune -f >/dev/null 2>&1 || true
docker image prune -af --filter until=336h >/dev/null 2>&1 || true
[ "$(id -u)" != 0 ] || fstrim -a >/dev/null 2>&1 || true
`;
