import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parse } from "yaml";
import type { SetupTaskPlan } from "../domain/execution-plan.js";
import { dependencyVolumeKey } from "./compose-target.js";
import type { DockerHost } from "./docker-host.js";

// A setup task that only fills the shared node_modules volumes does not need
// to run again in every new story: the volume is already filled. The stamp
// that says so lives on the Docker host next to the volumes, not in a
// worktree, and is trusted only while everything it was written for holds:
//
// - the task, the dependency key, what the install reads beyond that key and
//   the task container's environment are the ones the stamp was written for;
// - the volumes are the ones it filled (creation time) and nobody changed
//   what they hold since (a listing of their packages, see `signatures`);
// - the run wrote nothing outside those volumes: no file in the worktree and
//   nothing in a volume only this story has. Such a task, for example one
//   that generates code or copies an env file, runs in every story;
// - the task is a plain install (`npm install`, `corepack pnpm install
//   --frozen-lockfile`, ...). Any other command may read the worktree to fill
//   the volume (`prisma generate`) or write somewhere only when a file is
//   missing (`cp .env.example .env`), which one run cannot show.
//
// Anything that cannot be proven keeps the per-worktree stamp of the engine
// as the only rule. A new run removes the stamp first and only a run that
// succeeded writes it, so a failed or partial install leaves none.
//
// Every step is one script run on the Docker host, as root: reading the
// volumes needs it, and the stamp stays out of reach of the worktree.

export type SharedSetupOptions = {
  /** Directory on the Docker host for the stamps every story reads. */
  directory: string;
  /** The story's worktree on the Docker host: setup must not write to it. */
  workspace: string;
};

/** What the engine knows about the volumes and containers of a prepared project. */
export type SharedSetupProject = {
  serviceVolumes: Record<string, string[]>;
  volumeCreatedAt: Record<string, string>;
  sharedVolumes?: string[];
  setupDigests?: Record<string, string>;
};

export type SharedSetupInput = {
  host: DockerHost;
  options: SharedSetupOptions | undefined;
  task: SetupTaskPlan;
  serviceId: string;
  project: SharedSetupProject;
  /** The engine's own fingerprint of the task, which the stamp extends. */
  fingerprint: string;
  /** What the install reads beyond the dependency key; undefined: unknown. */
  inputs: string | undefined;
  /** File whose date marks the start of the run. */
  marker: string;
};

type Identity = {
  taskId: string;
  stamp: string;
  fingerprint: string;
  workspace: string;
  marker: string;
  /** Shared volumes the task fills. */
  tracked: string[];
  /** Volumes only this story has, which the task must not write to. */
  exclusive: string[];
};

type Step = "probe" | "claim" | "finish";

// The commands that only fetch packages: optional `corepack` setup, then a
// package manager's install with plain flags. Anything else is not shared.
const installFlags = String.raw`(?:\s+(?:--[\w-]+(?:=[^\s;&|<>"'$\x60()]+)?|-\w))*`;
const installSegments = [
  String.raw`\(?\s*corepack\s+enable(?:\s+2>/dev/null)?(?:\s*\|\|\s*true)?\s*\)?`,
  String.raw`corepack\s+prepare\s+[\w@.-]+(?:\s+--activate)?`,
  String.raw`(?:corepack\s+)?(?:npm|pnpm|bun)\s+(?:install|i|ci)${installFlags}`,
  String.raw`(?:corepack\s+)?yarn(?:\s+install)?${installFlags}`,
].map((pattern) => new RegExp(`^${pattern}$`));

function installsOnly(command: string) {
  const segments = command.split("&&").map((segment) => segment.trim());
  return (
    segments.every((segment) =>
      installSegments.some((pattern) => pattern.test(segment)),
    ) &&
    segments.some((segment) =>
      /(?:npm|pnpm|yarn|bun)(?:\s|$)/.test(segment.replace(/^corepack\s+/, "")),
    )
  );
}

/** The shared stamp of a task, or undefined when it cannot be shared. */
export function sharedSetupFor(input: SharedSetupInput) {
  const { options, task, serviceId, project } = input;
  if (!options || input.inputs === undefined) return undefined;
  // A task that waits for a service (a migration) or another task depends on
  // more than the volumes, and a database is not shared.
  if (task.dependsOn.length) return undefined;
  // The digest only knows an image by name: a Dockerfile of the worktree is
  // an input it does not hash.
  if (task.entrypoint || task.container.build || !installsOnly(task.command))
    return undefined;
  const digest = project.setupDigests?.[serviceId];
  if (!digest) return undefined;
  const volumes = project.serviceVolumes[serviceId] ?? [];
  const shared = new Set(project.sharedVolumes);
  const tracked = volumes.filter((name) => name in project.volumeCreatedAt);
  const keys = new Set(tracked.map(dependencyVolumeKey));
  if (
    !tracked.length ||
    keys.size !== 1 ||
    keys.has(undefined) ||
    tracked.some((name) => !shared.has(name) || !project.volumeCreatedAt[name])
  )
    return undefined;
  return new SharedSetup(input.host, {
    taskId: task.id,
    stamp: posix.join(
      options.directory,
      `${[...keys][0]}.${sha256(task.id, ...tracked).slice(0, 16)}.stamp`,
    ),
    fingerprint: sha256(input.fingerprint, input.inputs, digest),
    workspace: options.workspace,
    marker: input.marker,
    tracked,
    exclusive: volumes.filter((name) => !shared.has(name)),
  });
}

export class SharedSetup {
  constructor(
    private readonly host: DockerHost,
    private readonly identity: Identity,
  ) {}

  /** Whether the volumes still hold what an identical run left in them. */
  async done() {
    return (await this.run("probe")) === "valid";
  }

  /**
   * Called when it is this story's turn to install. `done`: another story
   * installed meanwhile. `run`: the stamp is removed and the run is noted;
   * call `finish` after it succeeds. `unshared`: run it, nothing to record.
   */
  async claim(): Promise<"done" | "run" | "unshared"> {
    const result = await this.run("claim");
    if (result === "valid") return "done";
    return result === "begun" ? "run" : "unshared";
  }

  /** Writes the stamp of a run that succeeded, if it wrote only the volumes. */
  async finish(log?: (message: string) => void) {
    const result = await this.run("finish");
    if (result === undefined)
      // The install ran, so the next story runs it too: say why.
      log?.(
        `Setup ${this.identity.taskId} could not be recorded for other stories (${this.failure}).\n`,
      );
    if (!result?.startsWith("wrote\t")) return;
    const root = `${this.identity.workspace}/`;
    const path = result.slice("wrote\t".length);
    log?.(
      `Setup ${this.identity.taskId} also wrote ${path.startsWith(root) ? path.slice(root.length) : path}, so it runs in every story.\n`,
    );
  }

  private failure = "";

  private async run(step: Step) {
    try {
      const result = await this.host.run(
        "sh",
        ["-c", script(this.identity, step)],
        { timeoutMs: 60_000 },
      );
      this.failure = `exit code ${result.exitCode} ${result.stderr.trim().slice(-300)}`;
      return result.exitCode === 0 ? result.stdout.trim() : undefined;
    } catch (error) {
      this.failure = String(error);
      return undefined;
    }
  }
}

// One script per step. The first line names the step, for people reading
// process lists and for test doubles of the Docker host.
function script(identity: Identity, step: Step) {
  const head = [
    `# shared-setup ${step}`,
    "set -u",
    '[ "$(id -u)" = 0 ] || exit 3',
    `stamp=${quote(identity.stamp)}`,
    `fp=${quote(identity.fingerprint)}`,
    `marker=${quote(identity.marker)}`,
    "nl='\n'",
  ];
  // The stamp is for this fingerprint, and the volumes hold what it saw.
  const unchanged = [
    `[ "$(head -n 1 "$stamp" 2>/dev/null)" = "fingerprint $fp" ] || ${step === "claim" ? "stale=1" : "{ echo stale; exit 0; }"}`,
    `if [ -z "\${stale:-}" ]; then`,
    ...signatures(identity.tracked),
    `  [ "$(cat "$stamp" 2>/dev/null)" = "\${expected%"$nl"}" ] || ${step === "claim" ? "stale=1" : "{ echo stale; exit 0; }"}`,
    "fi",
  ];
  if (step === "probe") return [...head, ...unchanged, "echo valid"].join("\n");
  if (step === "claim")
    return [
      ...head,
      ...unchanged,
      '[ -n "${stale:-}" ] || { echo valid; exit 0; }',
      // Forget the stamp and note when the run starts.
      'mkdir -p "$(dirname "$stamp")" "$(dirname "$marker")" || exit 3',
      ': > "$stamp" || exit 3',
      ': > "$marker" || exit 3',
      // The volumes are on the Docker host's disk, the worktree may not be:
      // each is compared with a marker made on its own side.
      ': > "$stamp.marker" || exit 3',
      "echo begun",
    ].join("\n");
  return [
    ...head,
    ...writes(identity),
    ...signatures(identity.tracked),
    'mkdir -p "$(dirname "$stamp")" || exit 3',
    'printf \'%s\' "$expected" > "$stamp.$$" || exit 3',
    'mv -f "$stamp.$$" "$stamp" || exit 3',
    "echo stamped",
  ].join("\n");
}

// What a run wrote: `find` lists the first path whose status changed after
// the marker, so a file written, replaced, renamed, deleted (its directory
// changes) or given back its old date is seen. `.git` and `.blame` belong to
// Blame. The volumes are mounted over directories the run cannot reach.
function writes({ workspace, exclusive }: Identity) {
  return [
    `hit="$(find -H ${quote(workspace)} \\( -path ${quote(`${workspace}/.git`)} -o -path ${quote(`${workspace}/.blame`)} \\) -prune -o -cnewer "$marker" -print -quit)" || exit 3`,
    `[ -z "$hit" ] || { printf 'wrote\\t%s\\n' "$hit"; exit 0; }`,
    ...exclusive.flatMap((name) => [
      `mp="$(docker volume inspect --format '{{.Mountpoint}}' ${quote(name)})" || exit 3`,
      `hit="$(find "$mp" -cnewer "$stamp.marker" -print -quit)" || exit 3`,
      `[ -z "$hit" ] || { printf 'wrote\\t%s\\n' ${quote(name)}; exit 0; }`,
    ]),
  ];
}

// A listing of the packages of a node_modules volume: what each entry of its
// first two levels (`name` and `@scope/name`) is, how big and since when, and
// the package managers' own records. It changes when a package manager
// installs or removes anything, such as an agent running `npm install x` in a
// container, and not when a tool fills its cache (`.cache`, `.vite`, ...).
// It does not see a file edited inside a package, which an install does not
// repair either. Sets `expected`, the content of the stamp.
const packageManagerRecords = [
  ".bin",
  ".pnpm",
  ".package-lock.json",
  ".modules.yaml",
  ".yarn-integrity",
  ".yarn-state.yml",
];

function signatures(tracked: string[]) {
  const allowed = packageManagerRecords
    .flatMap((record) => [`! -path './${record}'`, `! -path './${record}/*'`])
    .join(" ");
  return [
    "sigs=",
    ...tracked.flatMap((name) => [
      `mp="$(docker volume inspect --format '{{.Mountpoint}}' ${quote(name)})" || exit 3`,
      `listing="$(cd "$mp" && find . -mindepth 1 -maxdepth 2 \\( -path './.*' ${allowed} \\) -prune -o -printf '%P\\t%y\\t%s\\t%T@\\t%i\\n')" || exit 3`,
      `sum="$(printf '%s\\n' "$listing" | LC_ALL=C sort | sha256sum | cut -d' ' -f1)"`,
      `sigs="\${sigs}${name} $sum$nl"`,
    ]),
    `expected="fingerprint $fp$nl$sigs"`,
  ];
}

/**
 * A digest of what the rendered setup containers run with. A story whose
 * environment differs (`NODE_ENV=production` installs fewer packages) must not
 * reuse the install of another one. Paths of the story's own worktree stay
 * out of it.
 */
export function setupServiceDigests(yaml: string) {
  try {
    const services =
      (parse(yaml) as { services?: Record<string, Record<string, unknown>> })
        .services ?? {};
    return Object.fromEntries(
      Object.entries(services)
        .filter(([id]) => id.startsWith("setup-"))
        .map(([id, service]) => [
          id,
          sha256(
            JSON.stringify([
              service.image,
              service.entrypoint,
              service.command,
              service.working_dir,
              service.environment,
              service.env_file,
              service.user,
            ]),
          ),
        ]),
    );
  } catch {
    return {};
  }
}

function sha256(...parts: string[]) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function quote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
