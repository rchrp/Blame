// Shell run on the Docker host to hibernate, wake and watch local previews.
// Each is one round trip: the Blame Runtime agent runs it as root in the
// VM; on Linux it runs as the user, who may not write cgroup files, so the
// memory then stays where the kernel puts it.

/**
 * Pauses a project's running containers (cgroup freezer: no CPU, timers
 * stop), then asks the kernel to reclaim each one's memory: anonymous pages
 * go to swap, file pages are dropped. Writes a marker whose time the wake
 * compares the worktree's files with. Exit 3: nothing was running.
 */
export const hibernateScript = `
set -u
project="$1"
marker="$2"
ids="$(docker ps -q --no-trunc --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.oneoff=False --filter status=running)"
[ -n "$ids" ] || exit 3
touch "$marker" 2>/dev/null || true
docker pause $ids >/dev/null || exit 4
for id in $ids; do
  pid="$(docker inspect --format '{{.State.Pid}}' "$id" 2>/dev/null || echo 0)"
  path="$(sed -n 's/^0:://p' "/proc/$pid/cgroup" 2>/dev/null)"
  dir="/sys/fs/cgroup$path"
  before="$(cat "$dir/memory.current" 2>/dev/null || echo 0)"
  # Only the container's own cgroup: never a parent's.
  case "$path" in
    *"$id"*) [ ! -w "$dir/memory.reclaim" ] || echo "$before" >"$dir/memory.reclaim" 2>/dev/null || true ;;
  esac
  after="$(cat "$dir/memory.current" 2>/dev/null || echo 0)"
  printf 'container\\t%s\\t%s\\t%s\\t%s\\n' "$id" "$pid" "$before" "$after"
done
`;

/**
 * Unpauses a project's containers and reports what changed while it slept:
 * how many containers run, and the worktree's files written since the
 * marker, beyond which the watcher's inotify queue may have overflowed.
 */
export const wakeScript = `
set -u
project="$1"
marker="$2"
worktree="$3"
label="label=com.docker.compose.project=$project"
ids="$(docker ps -q --no-trunc --filter "$label" --filter status=paused)"
[ -z "$ids" ] || docker unpause $ids >/dev/null || exit 4
printf 'running\\t%s\\n' "$(docker ps -q --filter "$label" --filter label=com.docker.compose.oneoff=False --filter status=running | wc -l | tr -d ' ')"
printf 'queue\\t%s\\n' "$(cat /proc/sys/fs/inotify/max_queued_events 2>/dev/null || echo 16384)"
if [ -f "$marker" ]; then
  find "$worktree" -xdev \\( -name node_modules -o -name .git -o -name .blame \\) -prune \\
    -o -newer "$marker" -print 2>/dev/null | head -n 100000 >"$marker.changed"
  printf 'changed\\t%s\\n' "$(wc -l <"$marker.changed" | tr -d ' ')"
  grep -E '/(package\\.json|pnpm-lock\\.yaml|pnpm-workspace\\.yaml|package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|bun\\.lockb?|\\.npmrc|\\.nvmrc|\\.node-version|requirements[^/]*\\.txt|pyproject\\.toml|poetry\\.lock|uv\\.lock|Pipfile\\.lock|Gemfile\\.lock|composer\\.lock|go\\.sum|Cargo\\.lock|Dockerfile[^/]*|compose[^/]*\\.ya?ml|docker-compose[^/]*\\.ya?ml)$' "$marker.changed" |
    head -n 5 | sed 's/^/dependency\\t/'
  rm -f "$marker" "$marker.changed"
fi
`;

/** Unpauses a project's containers before Docker stops or removes them. */
export const unpauseScript = `
ids="$(docker ps -q --no-trunc --filter "label=com.docker.compose.project=$1" --filter status=paused)"
[ -z "$ids" ] || docker unpause $ids >/dev/null
`;

/** Every paused preview container: its project directory, pid, project. */
export const pausedPreviewsScript = `
ids="$(docker ps -q --no-trunc --filter label=blame.preview --filter label=com.docker.compose.oneoff=False --filter status=paused)"
[ -z "$ids" ] || docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}\t{{.State.Pid}}\t{{index .Config.Labels "com.docker.compose.project"}}' $ids
`;

/**
 * Prints "wake <pid>" once a client waits on a paused container: a
 * connection to one of its listening ports that did not exist when the
 * watch began (a new browser tab, a database client), or bytes it has not
 * read (a request on a kept-alive connection). It reads the container's
 * own network namespace, so ports published through docker-proxy, Lima,
 * WSL or iptables look the same. Arguments: proc root, ticks, pids.
 * A bounded life ends a watcher whose desktop went away.
 */
export const watchScript = `
proc="$1"
ticks="$2"
shift 2
exec awk -v proc="$proc" -v ticks="$ticks" -v pids="$*" '
function scan(pid, first,   files, f, line, n, i, field, port, key, count, listen, rows) {
  split("", listen)
  count = 0
  files[1] = proc "/" pid "/net/tcp"
  files[2] = proc "/" pid "/net/tcp6"
  for (f = 1; f <= 2; f++) {
    while ((getline line < files[f]) > 0) {
      n = split(line, field, " ")
      if (n < 5 || field[1] == "sl") continue
      split(field[2], port, ":")
      if (field[4] == "0A") listen[port[2]] = 1
      else if (field[4] == "01" || field[4] == "03") rows[++count] = port[2] " " field[2] " " field[3] " " field[5]
    }
    close(files[f])
  }
  for (i = 1; i <= count; i++) {
    split(rows[i], field, " ")
    if (!(field[1] in listen)) continue
    key = pid SUBSEP field[2] SUBSEP field[3]
    split(field[4], port, ":")
    if (first) { seen[key] = 1; continue }
    if (!(key in seen) || port[2] !~ /^0+$/) return 1
  }
  return 0
}
BEGIN {
  total = split(pids, list, " ")
  for (tick = 0; tick < ticks; tick++) {
    for (i = 1; i <= total; i++) {
      if (list[i] in woke) continue
      if (scan(list[i], tick == 0)) { woke[list[i]] = 1; print "wake " list[i]; fflush() }
    }
    if (system("sleep 0.5") != 0) exit
  }
}'
`;

export type HibernatedContainer = {
  id: string;
  pid: number;
  memoryBefore: number;
  memoryAfter: number;
};

export function parseHibernation(stdout: string): HibernatedContainer[] {
  return stdout.split("\n").flatMap((line) => {
    const [kind, id, pid, before, after] = line.split("\t");
    if (kind !== "container" || !id) return [];
    return [
      {
        id,
        pid: Number(pid) || 0,
        memoryBefore: Number(before) || 0,
        memoryAfter: Number(after) || 0,
      },
    ];
  });
}

export type WakeReport = {
  running: number;
  /** Files written while it slept; undefined without a marker. */
  changed?: number;
  inotifyQueue: number;
  dependencyInputs: string[];
};

export function parseWake(stdout: string): WakeReport {
  const report: WakeReport = {
    running: 0,
    inotifyQueue: 16_384,
    dependencyInputs: [],
  };
  for (const line of stdout.split("\n")) {
    const [kind, value = ""] = line.split("\t");
    if (kind === "running") report.running = Number(value) || 0;
    if (kind === "queue") report.inotifyQueue = Number(value) || 16_384;
    if (kind === "changed") report.changed = Number(value) || 0;
    if (kind === "dependency" && value) report.dependencyInputs.push(value);
  }
  return report;
}

/**
 * Why a woken preview must restart instead of resuming: its containers
 * are gone (Docker or the VM restarted), its dependencies changed, or so
 * many files changed that its file watcher lost events (each write costs
 * the inotify queue a few events; past it, watchers may miss changes).
 */
export function wakeRestartReason(report: WakeReport, expected: number) {
  if (report.running < expected)
    return "its containers stopped while it was hibernated";
  if (report.dependencyInputs.length)
    return `${report.dependencyInputs[0]!.replace(/^.*\//, "")} changed while it was hibernated`;
  if ((report.changed ?? 0) > report.inotifyQueue / 8)
    return `${report.changed} files changed while it was hibernated`;
  return undefined;
}

/** Paused containers grouped by worktree (their directory's parent). */
export function parsePausedPreviews(stdout: string) {
  const previews = new Map<
    string,
    {
      worktree: string;
      projectName: string;
      pids: number[];
      containers: number;
    }
  >();
  const suffix = "/.blame/preview";
  for (const line of stdout.split("\n")) {
    const [directory = "", pid, projectName] = line.trim().split("\t");
    if (!directory.endsWith(suffix) || !projectName) continue;
    const worktree = directory.slice(0, -suffix.length);
    const preview = previews.get(worktree) ?? {
      worktree,
      projectName,
      pids: [],
      containers: 0,
    };
    preview.containers += 1;
    if (Number(pid) > 0) preview.pids.push(Number(pid));
    previews.set(worktree, preview);
  }
  return [...previews.values()];
}
