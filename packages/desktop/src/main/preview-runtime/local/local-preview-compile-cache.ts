import { posix } from "node:path";
import type { PreviewExecutionPlan } from "@blame/preview-runtime";
import type { DockerHost } from "@blame/preview-runtime/compose";

// A dev server compiles lazily and keeps what it compiled in a cache inside
// the worktree. A new story's worktree has none, so its first pages compile
// everything again, node_modules included: twice the CPU and memory of a
// start that finds a cache. Stories that share a dependency key (the same
// manifests, so the same compiler version and the same node_modules) seed
// their empty cache from a snapshot of another story's.
//
// The compiler stays the judge of what is valid: only its own persistent
// cache is copied, never its build output, and it checks every source
// file, config and environment value against the restored entries (see
// local-preview-compile-cache.test.ts and docs/preview-runtime-unification.md).
// A snapshot is a copy taken while the source cache did not change; when
// anything is in doubt, the story starts without a seed.

/** A compiler cache Blame can seed, found from the packages a project uses. */
export type CompileCacheKind = {
  id: string;
  /** A dependency of the service's package that runs this compiler. */
  packages: string[];
  /** Cache directories, relative to the service's package directory. */
  directories: string[];
};

// Measured on Next.js 16.4 (2026-11-15): a seeded Turbopack start takes a
// fifth of the CPU and half the memory peak of a cold one. Next's webpack
// cache gave no gain, even when a story restarts on its own cache, and Vite
// keeps its dependency cache in node_modules, already shared.
export const compileCacheKinds: CompileCacheKind[] = [
  {
    id: "turbopack",
    packages: ["next"],
    directories: [".next/dev/cache/turbopack", ".next/cache/turbopack"],
  },
];

/** Snapshots older than this are taken again from the next cold start. */
export const compileCacheRefreshSeconds = 6 * 60 * 60;
const snapshotImage = "busybox:1.37.0";

export type CompileCacheTarget = {
  /** Worktree path on the Docker host. */
  worktree: string;
  dependencyKey: string;
  /** Cache directories relative to the worktree. */
  directories: string[];
  owner: { uid: number; gid: number };
};

/**
 * The compiler cache directories of the services a start runs, relative to
 * the worktree, from the dependencies of each service's package.
 */
export async function compileCacheDirectories(
  host: Pick<DockerHost, "readFile">,
  worktree: string,
  plan: Pick<PreviewExecutionPlan, "services">,
  serviceIds: string[],
) {
  const packages = new Set(
    plan.services
      .filter(({ id }) => serviceIds.includes(id))
      .map(({ workingDir }) => workspaceRelative(workingDir))
      .filter((directory): directory is string => directory !== undefined),
  );
  const directories: string[] = [];
  for (const directory of [...packages].sort()) {
    const manifest = await host.readFile(
      posix.join(worktree, directory, "package.json"),
    );
    for (const kind of kindsUsedBy(manifest)) {
      for (const cache of kind.directories)
        directories.push(posix.join(directory, cache));
    }
  }
  return [...new Set(directories)];
}

export function kindsUsedBy(manifest: string | undefined) {
  if (!manifest) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(manifest) as Record<string, unknown>;
  } catch {
    return [];
  }
  const dependencies = new Set(
    ["dependencies", "devDependencies"].flatMap((field) => {
      const value = parsed[field];
      return value && typeof value === "object" ? Object.keys(value) : [];
    }),
  );
  return compileCacheKinds.filter((kind) =>
    kind.packages.some((name) => dependencies.has(name)),
  );
}

function workspaceRelative(workingDir: string) {
  const normalized = posix.normalize(workingDir).replace(/\/$/, "");
  if (normalized === "/workspace") return ".";
  if (!normalized.startsWith("/workspace/")) return undefined;
  const relative = normalized.slice("/workspace/".length);
  return relative.split("/").includes("..") ? undefined : relative;
}

export function compileCacheVolume(dependencyKey: string) {
  return `blame_compile_cache_${dependencyKey.replace(/[^a-zA-Z0-9]/g, "")}`;
}

/** What a start found: its own cache, a seed from a snapshot, or nothing. */
export type CompileCacheSeed =
  | { state: "warm" }
  | { state: "seeded"; snapshotAgeSeconds: number }
  | { state: "cold"; reason: string };

/**
 * Fills the worktree's empty compiler cache from the snapshot of its
 * dependency key. A cache that already holds anything is left alone.
 */
export async function seedCompileCache(
  host: DockerHost,
  target: CompileCacheTarget,
): Promise<CompileCacheSeed> {
  if (!target.directories.length || !safeDirectories(target.directories))
    return { state: "cold", reason: "no compiler cache" };
  const volume = compileCacheVolume(target.dependencyKey);
  const checked = await host.run(
    "sh",
    [
      "-c",
      presenceScript,
      "sh",
      target.worktree,
      volume,
      ...target.directories,
    ],
    { timeoutMs: 30_000 },
  );
  const presence = checked.stdout.trim();
  if (checked.exitCode !== 0) return { state: "cold", reason: "check failed" };
  if (presence === "warm") return { state: "warm" };
  if (presence !== "snapshot") return { state: "cold", reason: "no snapshot" };
  const result = await host.run(
    "docker",
    [
      ...snapshotContainer(target.worktree, volume),
      seedScript,
      "sh",
      String(target.owner.uid),
      String(target.owner.gid),
      ...target.directories,
    ],
    { timeoutMs: 5 * 60_000 },
  );
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  const seeded = /^seeded (\d+)$/.exec(line);
  if (result.exitCode === 0 && seeded)
    return { state: "seeded", snapshotAgeSeconds: Number(seeded[1]) };
  if (result.exitCode === 0 && line === "warm") return { state: "warm" };
  return {
    state: "cold",
    reason: line || result.stderr.trim().slice(-200) || "seed failed",
  };
}

export type CompileCacheCapture = {
  /** The source must not change for this long before and during the copy. */
  quietSeconds?: number;
  /** How long to wait for a quiet source before giving up. */
  timeoutSeconds?: number;
};

/**
 * Takes the worktree's compiler cache as the snapshot of its dependency
 * key, once the compiler stopped writing it. The copy counts only when the
 * source listing (names, sizes, times, inodes) is the same before and
 * after it. Returns whether a new snapshot was published.
 */
export async function captureCompileCache(
  host: DockerHost,
  target: CompileCacheTarget,
  options: CompileCacheCapture = {},
) {
  if (!target.directories.length || !safeDirectories(target.directories))
    return false;
  const volume = compileCacheVolume(target.dependencyKey);
  const quiet = options.quietSeconds ?? 5;
  const timeout = options.timeoutSeconds ?? 90;
  const created = await host.run("sh", [
    "-c",
    createVolumeScript,
    "sh",
    volume,
    target.dependencyKey,
  ]);
  if (created.exitCode !== 0) return false;
  const result = await host.run(
    "docker",
    [
      ...snapshotContainer(target.worktree, volume),
      captureScript,
      "sh",
      String(quiet),
      String(timeout),
      ...target.directories,
    ],
    { timeoutMs: (timeout + 300) * 1_000 },
  );
  return result.exitCode === 0 && result.stdout.trim().endsWith("captured");
}

// Directories come from the plan and package names; refuse anything that
// could leave the worktree or the snapshot once joined in a shell.
function safeDirectories(directories: string[]) {
  return directories.every(
    (directory) =>
      /^[A-Za-z0-9._@+/-]+$/.test(directory) &&
      !directory.startsWith("/") &&
      !directory.split("/").includes(".."),
  );
}

function snapshotContainer(worktree: string, volume: string) {
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "0:0",
    "--label",
    "blame.preview=true",
    "-v",
    `${worktree}:/w`,
    "-v",
    `${volume}:/c`,
    snapshotImage,
    "sh",
    "-c",
  ];
}

// warm: a cache directory holds something; snapshot: the volume exists.
const presenceScript = `
worktree="$1"; volume="$2"; shift 2
for d; do
  [ -n "$(ls -A "$worktree/$d" 2>/dev/null)" ] && { echo warm; exit 0; }
done
if docker volume inspect "$volume" >/dev/null 2>&1; then echo snapshot; else echo none; fi
`;

const createVolumeScript = `
docker volume inspect "$1" >/dev/null 2>&1 ||
  docker volume create --label blame.preview=true --label blame.shared=true --label "blame.compile-cache=$2" "$1" >/dev/null
`;

// /c/current names the published snapshot; each snapshot is a directory
// that is never written again, so a seed reads it without a lock. A seed
// copies next to the target, then renames, so a failed copy leaves the
// cache empty rather than partial. Directories it creates go to the
// worktree's owner.
const seedScript = `
set -u
uid="$1"; gid="$2"; shift 2
name="$(cat /c/current 2>/dev/null)" || { echo "no snapshot"; exit 0; }
snap="/c/$name"
[ -n "$name" ] && [ -d "$snap" ] || { echo "no snapshot"; exit 0; }
for d; do [ -n "$(ls -A "/w/$d" 2>/dev/null)" ] && { echo warm; exit 0; }; done
seeded=0
for d; do
  [ -d "$snap/$d" ] || continue
  parent="\${d%/*}"; [ "$parent" = "$d" ] && parent=.
  mkdir -p "/w/$parent" || { echo "cannot create $parent"; exit 1; }
  rm -rf "/w/$d.blame-seed"
  if ! cp -a "$snap/$d" "/w/$d.blame-seed"; then
    rm -rf "/w/$d.blame-seed"; echo "copy failed"; exit 1
  fi
  chown -R "$uid:$gid" "/w/$d.blame-seed"
  rm -rf "/w/$d" && mv "/w/$d.blame-seed" "/w/$d" || { rm -rf "/w/$d.blame-seed"; echo "rename failed"; exit 1; }
  path=/w
  for part in $(echo "$parent" | tr / ' '); do
    path="$path/$part"
    [ "$(stat -c %u "$path")" = 0 ] && chown "$uid:$gid" "$path"
  done
  seeded=1
done
[ "$seeded" = 1 ] || { echo "snapshot has no cache for this worktree"; exit 0; }
echo "seeded $(( $(date +%s) - $(stat -c %Y "$snap") ))"
`;

// One capture at a time per snapshot (a lock directory, stale after ten
// minutes). The source must be quiet: no entry changed in the last
// \`quiet\` seconds, and the same listing before and after the copy.
const captureScript = `
set -u
quiet="$1"; timeout="$2"; shift 2
now() { date +%s; }
if ! mkdir /c/.capturing 2>/dev/null; then
  [ $(( $(now) - $(stat -c %Y /c/.capturing) )) -gt 600 ] || { echo busy; exit 0; }
  touch /c/.capturing
fi
trap 'rm -rf /c/.capturing "/c/.incoming-$$"' EXIT
listing() {
  for d; do [ -d "/w/$d" ] && find "/w/$d" -exec stat -c '%n %s %Y %Z %i' {} +; done | sort
}
newest() { listing "$@" | awk '{ if ($3 > m) m = $3; if ($4 > m) m = $4 } END { print m + 0 }'; }
deadline=$(( $(now) + timeout ))
while :; do
  [ "$(now)" -le "$deadline" ] || { echo "source never quiet"; exit 0; }
  before="$(listing "$@")"
  [ -n "$before" ] || { echo "nothing to capture"; exit 0; }
  if [ $(( $(now) - $(newest "$@") )) -lt "$quiet" ]; then sleep 2; continue; fi
  tmp="/c/.incoming-$$"; rm -rf "$tmp"; mkdir -p "$tmp"
  ok=1
  for d; do
    [ -d "/w/$d" ] || continue
    parent="\${d%/*}"; [ "$parent" = "$d" ] && parent=.
    mkdir -p "$tmp/$parent" && cp -a "/w/$d" "$tmp/$d" || { ok=0; break; }
  done
  [ "$ok" = 1 ] || { echo "copy failed"; exit 1; }
  [ "$before" = "$(listing "$@")" ] && break
  sleep 2
done
name="snapshot-$(now)-$$"
mv "$tmp" "/c/$name" && touch "/c/$name" || exit 1
previous="$(cat /c/current 2>/dev/null || true)"
echo "$name" > /c/.current-$$ && mv /c/.current-$$ /c/current || exit 1
# Keep the previous snapshot for a seed that may still read it.
for old in /c/snapshot-*; do
  base="\${old##*/}"
  [ "$base" = "$name" ] || [ "$base" = "$previous" ] || rm -rf "$old"
done
echo captured
`;
