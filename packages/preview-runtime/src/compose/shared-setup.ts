import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parse } from "yaml";
import type { SetupTaskPlan } from "../domain/execution-plan.js";
import { dependencyVolumeKey } from "./compose-target.js";
import type { DockerHost } from "./docker-host.js";

// A setup task that only fills the shared node_modules volumes does not need
// to run again in every new story: the volume is already filled. The stamp
// that says so lives next to the volumes, on the Docker host, and is trusted
// only while everything it was written for still holds:
//
// - the task, the dependency key, what the install reads beyond that key and
//   the task container's environment are the ones the stamp was written for;
// - the volumes are the ones it filled (creation time), and nobody changed
//   what they hold since (a listing of their packages, see `signatureScript`);
// - the run wrote nothing outside those volumes: no file in the worktree and
//   nothing in a volume only this story has. Such a task, for example one
//   that generates code or copies an env file, runs again in every story.
//
// Anything that cannot be proven keeps the per-worktree stamp of the engine
// as the only rule. The stamp is written after a successful run only, and a
// new run removes it first, so a failed or partial install leaves none.

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

type Stamp = { version: 1; fingerprint: string; signatures: string[] };

type Probe = {
  signatures: Record<string, string>;
  /** First thing the run wrote outside the shared volumes, when it did. */
  wrote?: string;
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
  /** File whose time marks the start of the run. */
  marker: string;
};

/** The shared stamp of a task, or undefined when it cannot be shared. */
export function sharedSetupFor(input: SharedSetupInput) {
  const { options, task, serviceId, project } = input;
  if (!options || input.inputs === undefined) return undefined;
  // A task that waits for a service (a migration) or another task depends on
  // more than the volumes, and a database is not shared.
  if (task.dependsOn.length) return undefined;
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
  return new SharedSetup(input, {
    path: posix.join(
      options.directory,
      `${[...keys][0]}.${sha256(task.id, ...tracked).slice(0, 16)}.json`,
    ),
    fingerprint: sha256(input.fingerprint, input.inputs, digest),
    tracked,
    // Volumes only this story has: a run that fills one leaves the next
    // story without it.
    exclusive: volumes.filter((name) => !shared.has(name)),
  });
}

class SharedSetup {
  constructor(
    private readonly input: SharedSetupInput,
    private readonly identity: {
      path: string;
      fingerprint: string;
      tracked: string[];
      exclusive: string[];
    },
  ) {}

  /** Whether the volumes still hold what an identical run left in them. */
  async done() {
    const stamp = await this.read();
    if (stamp?.fingerprint !== this.identity.fingerprint) return false;
    const probe = await this.probe(false);
    return (
      probe !== undefined &&
      this.signatures(probe) === stamp.signatures.join("\n")
    );
  }

  /** Forgets the stamp and notes when the run starts. False: do not trust it. */
  async begin() {
    try {
      await this.input.host.writeFile(this.identity.path, "");
      await this.input.host.writeFile(this.input.marker, `${Date.now()}`);
      return true;
    } catch {
      return false;
    }
  }

  /** Writes the stamp of a run that succeeded, if it wrote only the volumes. */
  async finish(log?: (message: string) => void) {
    const probe = await this.probe(true);
    if (!probe) return;
    if (probe.wrote !== undefined) {
      log?.(
        `Setup ${this.input.task.id} also wrote ${probe.wrote}, so it runs in every story.\n`,
      );
      return;
    }
    const stamp: Stamp = {
      version: 1,
      fingerprint: this.identity.fingerprint,
      signatures: this.signatures(probe).split("\n"),
    };
    try {
      await this.input.host.writeFile(
        this.identity.path,
        JSON.stringify(stamp),
      );
    } catch {
      // The next story runs the setup itself.
    }
  }

  private signatures(probe: Probe) {
    return this.identity.tracked
      .map((name) => `${name} ${probe.signatures[name] ?? ""}`)
      .join("\n");
  }

  private async read() {
    try {
      const value = await this.input.host.readFile(this.identity.path);
      const stamp = value ? (JSON.parse(value) as Stamp) : undefined;
      return stamp?.version === 1 && Array.isArray(stamp.signatures)
        ? stamp
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async probe(afterRun: boolean): Promise<Probe | undefined> {
    const script = [
      "set -u",
      '[ "$(id -u)" = 0 ] || exit 3',
      ...(afterRun
        ? writeScript(
            this.input.options!.workspace,
            this.input.marker,
            this.identity.exclusive,
          )
        : []),
      ...this.identity.tracked.map(signatureScript),
    ].join("\n");
    try {
      const result = await this.input.host.run("sh", ["-c", script], {
        timeoutMs: 60_000,
      });
      if (result.exitCode !== 0) return undefined;
      const probe: Probe = { signatures: {} };
      for (const line of result.stdout.split("\n")) {
        const [kind, name, value] = line.split("\t");
        if (kind === "wrote" && name !== undefined)
          return { signatures: {}, wrote: relativeTo(this.input, name) };
        if (kind === "signature" && name && value)
          probe.signatures[name] = value;
      }
      return this.identity.tracked.every((name) => probe.signatures[name])
        ? probe
        : undefined;
    } catch {
      return undefined;
    }
  }
}

// What a run wrote: `find` lists the first path whose status changed after
// the marker, so a file written, replaced, renamed, deleted (its directory
// changes) or given back its old date is seen. `.git` and `.blame` belong to
// Blame. The volumes are mounted over directories the run cannot reach.
function writeScript(workspace: string, marker: string, exclusive: string[]) {
  const quotedMarker = shellQuote(marker);
  return [
    `hit="$(find ${shellQuote(workspace)} \\( -path ${shellQuote(`${workspace}/.git`)} -o -path ${shellQuote(`${workspace}/.blame`)} \\) -prune -o -cnewer ${quotedMarker} -print -quit)" || exit 3`,
    `[ -z "$hit" ] || { printf 'wrote\\t%s\\n' "$hit"; exit 0; }`,
    ...exclusive.flatMap((name) => [
      `mp="$(docker volume inspect --format '{{.Mountpoint}}' ${shellQuote(name)})" || exit 3`,
      `hit="$(find "$mp" -cnewer ${quotedMarker} -print -quit)" || exit 3`,
      `[ -z "$hit" ] || { printf 'wrote\\t%s\\n' ${shellQuote(name)}; exit 0; }`,
    ]),
  ];
}

// A listing of the packages of a node_modules volume: what each entry of its
// first two levels (`name` and `@scope/name`) is, how big and since when, and
// the package managers' own records. It changes when a package manager
// installs or removes anything, such as an agent running `npm install x` in a
// container, and not when a tool fills its cache (`.cache`, `.vite`, ...).
// It does not see a file edited inside a package, which an install does not
// repair either.
const packageManagerRecords = [
  ".bin",
  ".pnpm",
  ".package-lock.json",
  ".modules.yaml",
  ".yarn-integrity",
  ".yarn-state.yml",
];

function signatureScript(name: string) {
  const allowed = packageManagerRecords
    .flatMap((record) => [`! -path './${record}'`, `! -path './${record}/*'`])
    .join(" ");
  return [
    `mp="$(docker volume inspect --format '{{.Mountpoint}}' ${shellQuote(name)})" || exit 3`,
    `listing="$(cd "$mp" && find . -mindepth 1 -maxdepth 2 \\( -path './.*' ${allowed} \\) -prune -o -printf '%P\\t%y\\t%s\\t%T@\\t%i\\n')" || exit 3`,
    `printf 'signature\\t%s\\t%s\\n' ${shellQuote(name)} "$(printf '%s\\n' "$listing" | LC_ALL=C sort | sha256sum | cut -d' ' -f1)"`,
  ].join("\n");
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

function relativeTo(input: SharedSetupInput, path: string) {
  const root = `${input.options!.workspace}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

function sha256(...parts: string[]) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
