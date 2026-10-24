import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { PreviewExecutionPlan } from "../domain/execution-plan.js";
import { installsPackages } from "../compilation/command-normalization.js";
import { setupServiceId, type RenderedCompose } from "./compose-renderer.js";
import {
  ComposeEngineError,
  commandFailureDetail,
  type CommandResult,
  type DockerHost,
  type HostCommandOptions,
} from "./docker-host.js";
import { selectedSetupTasks } from "./service-selection.js";

// Runs a rendered Compose project on a Docker host. The sandbox runner and
// the desktop drive previews through this engine, so setup caching, image
// preparation, start order and readiness behave the same in both.

export type EnginePhase =
  | "compose.prepare"
  | "compose.pull"
  | "compose.build"
  | "dependencies.install"
  | "services.start";

export type WorkspaceFingerprints = {
  /** Hash of the dependency lockfiles; a change reruns the setup tasks. */
  lockfiles(): Promise<string>;
  /**
   * Hash of a build context's files. Without it, buildable images are
   * rebuilt on every start and Docker's build cache makes that cheap.
   */
  buildContext?(context: string): Promise<string | undefined>;
};

export type ComposeEngineOptions = {
  host: DockerHost;
  /** Directory on the Docker host for the Compose file and the stamps. */
  stateDirectory: string;
  /** Progress lines and command output, for the preview run log. */
  log?: (message: string) => void;
  measure?: <T>(phase: EnginePhase, action: () => Promise<T>) => Promise<T>;
  setupTimeoutMs?: number;
  startTimeoutMs?: number;
};

export type EngineOwner = { uid: number; gid: number };

export type ServiceState = {
  id: string;
  running: boolean;
  healthy?: boolean;
  state?: string;
  exitCode?: number;
};

type PreparedProject = {
  fingerprint: string;
  projectName: string;
  targets: RenderedCompose["targets"];
  serviceVolumes: RenderedCompose["serviceVolumes"];
  /** Mountpoint of every engine volume that records setup runs. */
  markers: Record<string, string>;
};

const markerFile = ".blame-setup-fingerprints.json";
const defaultSetupTimeoutMs = 15 * 60_000;
const defaultStartTimeoutMs = 10 * 60_000;

export class ComposeEngine {
  private readonly options: ComposeEngineOptions;

  constructor(options: ComposeEngineOptions) {
    this.options = options;
  }

  get composeFile() {
    return posix.join(this.options.stateDirectory, "compose.yaml");
  }

  /** Writes the Compose file and creates the engine volumes for `owner`. */
  async prepare(rendered: RenderedCompose, owner: EngineOwner) {
    return this.measure("compose.prepare", async () => {
      const fingerprint = sha256(
        rendered.yaml,
        JSON.stringify(rendered.targets),
      );
      const previous = await this.prepared();
      if (previous?.fingerprint !== fingerprint) {
        await this.options.host.writeFile(this.composeFile, rendered.yaml);
      }
      const mountpoints = await this.ensureVolumes(rendered, owner);
      const markers = Object.fromEntries(
        rendered.volumes
          .filter(({ setupMarker }) => setupMarker)
          .map(({ name }) => [name, mountpoints[name]!]),
      );
      const project: PreparedProject = {
        fingerprint,
        projectName: rendered.projectName,
        targets: rendered.targets,
        serviceVolumes: rendered.serviceVolumes,
        markers,
      };
      await this.writeJson("project.json", project);
      return { changed: previous?.fingerprint !== fingerprint };
    });
  }

  /** Runs the setup the services need, then starts them once healthy. */
  async start(
    plan: PreviewExecutionPlan,
    serviceIds: string[],
    fingerprints: WorkspaceFingerprints,
  ) {
    if (!serviceIds.length) return;
    await this.runSetup(plan, serviceIds, fingerprints);
    await this.prepareImages(plan, serviceIds, fingerprints);
    await this.measure("services.start", () =>
      this.compose(
        [
          "up",
          "--detach",
          "--wait",
          "--wait-timeout",
          String(Math.ceil(this.startTimeoutMs / 1_000)),
          "--remove-orphans",
          "--no-build",
          ...serviceIds,
        ],
        { timeoutMs: this.startTimeoutMs + 30_000 },
      ),
    );
  }

  /** Runs every setup task and prepares every image, as a warm baseline. */
  async warm(plan: PreviewExecutionPlan, fingerprints: WorkspaceFingerprints) {
    const serviceIds = plan.services.map(({ id }) => id);
    await this.runSetup(plan, serviceIds, fingerprints);
    await this.prepareImages(
      plan,
      [...plan.setup.map(({ id }) => setupServiceId(id)), ...serviceIds],
      fingerprints,
    );
  }

  /** Stops the services. `remove` also deletes their containers. */
  async stop(options: { remove?: boolean } = {}) {
    if (!(await this.prepared())) return;
    await this.compose(
      options.remove
        ? ["down", "--remove-orphans", "--timeout", "5"]
        : ["stop", "--timeout", "5"],
      { timeoutMs: 120_000 },
    );
  }

  /** Removes the project, with its own volumes; shared caches stay. */
  async remove() {
    if (!(await this.prepared())) return;
    await this.compose(
      ["down", "--remove-orphans", "--volumes", "--timeout", "5"],
      { timeoutMs: 120_000 },
    );
  }

  async inspect(plan: Pick<PreviewExecutionPlan, "services">) {
    const result = (await this.prepared())
      ? await this.compose(["ps", "--all", "--format", "json"], {}, true)
      : undefined;
    const rows = parseJsonLines(result?.exitCode === 0 ? result.stdout : "");
    return plan.services.map(({ id }): ServiceState => {
      const row = rows.find(({ Service }) => Service === id);
      return {
        id,
        running: row?.State === "running",
        healthy: row?.Health ? row.Health === "healthy" : undefined,
        state: row?.State,
        exitCode: row?.ExitCode,
      };
    });
  }

  async targets() {
    return (await this.requiredPrepared()).targets;
  }

  async execInService(
    serviceId: string,
    args: string[],
    options: HostCommandOptions = {},
  ) {
    return this.compose(["exec", "-T", serviceId, ...args], options, true);
  }

  async logs(
    serviceId: string | undefined,
    options: HostCommandOptions & { tail?: number; follow?: boolean } = {},
  ) {
    return this.compose(
      [
        "logs",
        "--no-color",
        "--tail",
        String(options.tail ?? 500),
        ...(options.follow ? ["--follow"] : []),
        ...(serviceId ? [serviceId] : []),
      ],
      options,
      true,
    );
  }

  /** Runs a Compose command on the prepared project. */
  async compose(
    args: string[],
    options: HostCommandOptions = {},
    allowFailure = false,
  ): Promise<CommandResult> {
    const project = await this.requiredPrepared();
    const result = await this.options.host.run(
      "docker",
      [
        "compose",
        "--ansi",
        "never",
        "--progress",
        "plain",
        "--project-name",
        project.projectName,
        "--file",
        this.composeFile,
        ...args,
      ],
      options,
    );
    if (!allowFailure && result.exitCode !== 0) {
      throw new ComposeEngineError(
        "COMPOSE_COMMAND_FAILED",
        `Compose ${args[0]} failed: ${commandFailureDetail(result.stderr, result.stdout)}`,
      );
    }
    return result;
  }

  private async runSetup(
    plan: PreviewExecutionPlan,
    serviceIds: string[],
    fingerprints: WorkspaceFingerprints,
  ) {
    const tasks = selectedSetupTasks(plan, serviceIds);
    if (!tasks.length) return;
    const project = await this.requiredPrepared();
    const stamps = await this.readJson<Record<string, string>>(
      "setup-fingerprints.json",
      {},
    );
    const lockfiles = await fingerprints.lockfiles();
    for (const task of tasks) {
      const serviceId = setupServiceId(task.id);
      const dependencies = task.dependsOn.filter((id) =>
        plan.services.some((service) => service.id === id),
      );
      await this.prepareImages(
        plan,
        [serviceId, ...dependencies],
        fingerprints,
      );
      // A recreated dependency, such as a fresh database, gets its setup
      // again: its container identity is part of the fingerprint.
      const containers = dependencies.length
        ? await this.startDependencies(dependencies)
        : "";
      const fingerprint = sha256(JSON.stringify(task), lockfiles, containers);
      const markers = installsPackages(task.command)
        ? (project.serviceVolumes[serviceId] ?? []).flatMap((name) =>
            project.markers[name] ? [project.markers[name]] : [],
          )
        : [];
      if (await this.setupDone(task.id, fingerprint, stamps, markers)) {
        this.options.log?.(`Setup ${task.id} is up to date.\n`);
        continue;
      }
      this.options.log?.(`Running setup ${task.id}.\n`);
      await this.measure("dependencies.install", () =>
        this.compose(["run", "--rm", "--no-deps", serviceId], {
          timeoutMs: this.options.setupTimeoutMs ?? defaultSetupTimeoutMs,
          onOutput: this.options.log,
        }),
      );
      await Promise.all(
        markers.map((mountpoint) =>
          this.writeMarker(mountpoint, task.id, fingerprint),
        ),
      );
      stamps[task.id] = fingerprint;
      await this.writeJson("setup-fingerprints.json", stamps);
    }
  }

  private async startDependencies(serviceIds: string[]) {
    await this.compose(
      [
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        String(Math.ceil(this.startTimeoutMs / 1_000)),
        "--no-build",
        ...serviceIds,
      ],
      { timeoutMs: this.startTimeoutMs + 30_000, onOutput: this.options.log },
    );
    const result = await this.compose(["ps", "--quiet", ...serviceIds]);
    return result.stdout.split("\n").filter(Boolean).sort().join(",");
  }

  private async setupDone(
    taskId: string,
    fingerprint: string,
    stamps: Record<string, string>,
    markers: string[],
  ) {
    if (!markers.length) return stamps[taskId] === fingerprint;
    const recorded = await Promise.all(
      markers.map((mountpoint) => this.readMarker(mountpoint)),
    );
    return recorded.every((entries) => entries[taskId] === fingerprint);
  }

  private async prepareImages(
    plan: PreviewExecutionPlan,
    serviceIds: string[],
    fingerprints: WorkspaceFingerprints,
  ) {
    const stamps = await this.readJson<Record<string, string>>(
      "image-fingerprints.json",
      {},
    );
    const current = new Map<string, string | undefined>();
    for (const id of serviceIds) {
      current.set(id, await imageFingerprint(plan, id, fingerprints));
    }
    const pending = serviceIds.filter(
      (id) => !current.get(id) || stamps[id] !== current.get(id),
    );
    if (!pending.length) return;
    await this.measure("compose.pull", () =>
      this.compose(
        ["pull", "--policy", "missing", "--ignore-buildable", ...pending],
        { onOutput: this.options.log },
      ),
    );
    const buildable = pending.filter(
      (id) => imageItem(plan, id)?.container.build,
    );
    if (buildable.length) {
      await this.measure("compose.build", () =>
        this.compose(["build", ...buildable], {
          timeoutMs: this.options.setupTimeoutMs ?? defaultSetupTimeoutMs,
          onOutput: this.options.log,
        }),
      );
    }
    for (const id of pending) {
      const fingerprint = current.get(id);
      if (fingerprint) stamps[id] = fingerprint;
    }
    await this.writeJson("image-fingerprints.json", stamps);
  }

  // One host command creates every volume, checks that Docker keeps it in
  // its own volume directory and gives it to its owner.
  private async ensureVolumes(rendered: RenderedCompose, owner: EngineOwner) {
    if (!rendered.volumes.length) return {} as Record<string, string>;
    const script = rendered.volumes
      .map(({ name, owner: kind, shared }) => {
        const labels = `--label blame.preview=true${shared ? " --label blame.shared=true" : ""}`;
        const identity =
          kind === "project" ? `${owner.uid}:${owner.gid}` : "0:0";
        return [
          `docker volume create ${labels} ${shellQuote(name)} >/dev/null`,
          `mp="$(docker volume inspect --format '{{.Mountpoint}}' ${shellQuote(name)})"`,
          `case "$mp" in /*/volumes/*/_data) ;; *) echo "volume ${name} has mountpoint $mp" >&2; exit 3;; esac`,
          `[ "$(stat -c %u:%g "$mp")" = "${identity}" ] || chown ${identity} "$mp"`,
          `printf '%s\\t%s\\n' ${shellQuote(name)} "$mp"`,
        ].join(" && ");
      })
      .join("\n");
    const result = await this.options.host.run("sh", [
      "-c",
      `set -e\n${script}`,
    ]);
    if (result.exitCode !== 0) {
      throw new ComposeEngineError(
        "INVALID_CACHE_VOLUME",
        `Preview volumes could not be prepared: ${commandFailureDetail(result.stderr, result.stdout)}`,
      );
    }
    return Object.fromEntries(
      result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t") as [string, string]),
    );
  }

  private async readMarker(mountpoint: string) {
    const value = await this.options.host.readFile(
      posix.join(mountpoint, markerFile),
    );
    return parseRecord(value);
  }

  private async writeMarker(
    mountpoint: string,
    taskId: string,
    fingerprint: string,
  ) {
    const entries = await this.readMarker(mountpoint);
    entries[taskId] = fingerprint;
    await this.options.host.writeFile(
      posix.join(mountpoint, markerFile),
      JSON.stringify(entries),
    );
  }

  async prepared() {
    const value = await this.readJson<PreparedProject | undefined>(
      "project.json",
      undefined,
    );
    return value?.projectName ? value : undefined;
  }

  private async requiredPrepared() {
    const project = await this.prepared();
    if (!project) {
      throw new ComposeEngineError(
        "ENGINE_NOT_PREPARED",
        "Preview engine is not prepared.",
      );
    }
    return project;
  }

  private async readJson<T>(name: string, fallback: T): Promise<T> {
    const value = await this.options.host.readFile(
      posix.join(this.options.stateDirectory, name),
    );
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(name: string, value: unknown) {
    return this.options.host.writeFile(
      posix.join(this.options.stateDirectory, name),
      JSON.stringify(value),
    );
  }

  private get startTimeoutMs() {
    return this.options.startTimeoutMs ?? defaultStartTimeoutMs;
  }

  private measure<T>(phase: EnginePhase, action: () => Promise<T>) {
    return this.options.measure
      ? this.options.measure(phase, action)
      : action();
  }
}

async function imageFingerprint(
  plan: PreviewExecutionPlan,
  id: string,
  fingerprints: WorkspaceFingerprints,
) {
  const item = imageItem(plan, id);
  if (!item) return undefined;
  const context = item.container.build?.context;
  const contextHash = context ? await fingerprints.buildContext?.(context) : "";
  if (contextHash === undefined) return undefined;
  return sha256(JSON.stringify(item.container), contextHash);
}

function imageItem(plan: PreviewExecutionPlan, id: string) {
  return id.startsWith("setup-")
    ? plan.setup.find((task) => setupServiceId(task.id) === id)
    : plan.services.find((service) => service.id === id);
}

function parseJsonLines(value: string) {
  return value
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [];
      }
    }) as Array<{
    Service?: string;
    State?: string;
    Health?: string;
    ExitCode?: number;
  }>;
}

function parseRecord(value: string | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(value ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
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

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
