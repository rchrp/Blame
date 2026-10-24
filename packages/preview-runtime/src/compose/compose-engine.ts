import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { PreviewExecutionPlan } from "../domain/execution-plan.js";
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
  /** Docker's health status: starting, healthy or unhealthy. */
  health?: string;
  /** Docker's container state, such as running, exited or created. */
  state?: string;
  exitCode?: number;
};

type PreparedProject = {
  fingerprint: string;
  projectName: string;
  targets: RenderedCompose["targets"];
  serviceVolumes: RenderedCompose["serviceVolumes"];
  /** Creation time of the volumes a setup task fills, by volume name. */
  volumeCreatedAt: Record<string, string>;
};

const ownershipImage = "busybox:1.37.0";
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
      const createdAt = await this.ensureVolumes(rendered, owner);
      const volumeCreatedAt = Object.fromEntries(
        rendered.volumes
          .filter(({ tracksSetup }) => tracksSetup)
          .map(({ name }) => [name, createdAt[name] ?? ""]),
      );
      const project: PreparedProject = {
        fingerprint,
        projectName: rendered.projectName,
        targets: rendered.targets,
        serviceVolumes: rendered.serviceVolumes,
        volumeCreatedAt,
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

  /**
   * Prepares a later start without running anything that stays up: pulls
   * or builds every image and runs the setup tasks that need no service,
   * such as dependency installs. Tasks that need a service, such as
   * migrations, wait for the real start.
   */
  async prefetch(
    plan: PreviewExecutionPlan,
    fingerprints: WorkspaceFingerprints,
  ) {
    await this.prepareImages(
      plan,
      [
        ...plan.setup.map(({ id }) => setupServiceId(id)),
        ...plan.services.map(({ id }) => id),
      ],
      fingerprints,
    );
    // With no service selected, only the tasks that need none qualify.
    await this.runSetupTasks(plan, selectedSetupTasks(plan, []), fingerprints);
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

  /**
   * Reads the state of each service's container from the Docker Engine.
   * Previews are polled every few seconds, and `docker compose ps` costs
   * about fifteen times more CPU than asking the engine directly.
   */
  async inspect(plan: Pick<PreviewExecutionPlan, "services">) {
    const project = await this.prepared();
    const result = project
      ? await this.options.host.run("sh", [
          "-c",
          inspectScript,
          "sh",
          project.projectName,
        ])
      : undefined;
    const rows = parseContainerRows(
      result?.exitCode === 0 ? result.stdout : "",
    );
    return plan.services.map(({ id }): ServiceState => {
      const matching = rows.filter(({ service }) => service === id);
      const row =
        matching.find(({ state }) => state === "running") ?? matching[0];
      return {
        id,
        running: row?.state === "running",
        healthy: row?.health ? row.health === "healthy" : undefined,
        health: row?.health,
        state: row?.state,
        exitCode: row?.exitCode,
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
    await this.runSetupTasks(
      plan,
      selectedSetupTasks(plan, serviceIds),
      fingerprints,
    );
  }

  private async runSetupTasks(
    plan: PreviewExecutionPlan,
    tasks: PreviewExecutionPlan["setup"],
    fingerprints: WorkspaceFingerprints,
  ) {
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
      // Setup runs again when what it filled is gone: a recreated
      // dependency, such as a fresh database, or a recreated node_modules
      // volume. Container identities and volume creation times are part of
      // the fingerprint.
      const containers = dependencies.length
        ? await this.startDependencies(dependencies)
        : "";
      const volumes = (project.serviceVolumes[serviceId] ?? [])
        .filter((name) => name in project.volumeCreatedAt)
        .map((name) => `${name}@${project.volumeCreatedAt[name]}`)
        .join(",");
      const fingerprint = sha256(
        JSON.stringify(task),
        lockfiles,
        containers,
        volumes,
      );
      if (stamps[task.id] === fingerprint) {
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

  // One host command creates the missing volumes, gives each to its owner
  // and reports when every volume was created. The owner applies at
  // creation only: an image such as Postgres then takes over its own data
  // directory. Without root on the Docker host, a throwaway container
  // changes the owner.
  private async ensureVolumes(rendered: RenderedCompose, owner: EngineOwner) {
    if (!rendered.volumes.length) return {} as Record<string, string>;
    const script = rendered.volumes
      .map(({ name, owner: kind, shared }) => {
        const labels = `--label blame.preview=true${shared ? " --label blame.shared=true" : ""}`;
        const volume = shellQuote(name);
        const identity = `${owner.uid}:${owner.gid}`;
        const chown =
          kind === "project"
            ? `if [ "$(id -u)" = 0 ]; then chown ${identity} "$(docker volume inspect --format '{{.Mountpoint}}' ${volume})"; else docker run --rm --network none --user 0:0 -v ${volume}:/v ${ownershipImage} chown ${identity} /v; fi`
            : ":";
        return [
          `if ! docker volume inspect ${volume} >/dev/null 2>&1; then`,
          `  docker volume create ${labels} ${volume} >/dev/null`,
          `  ${chown}`,
          `fi`,
          `printf '%s\\t%s\\n' ${volume} "$(docker volume inspect --format '{{.CreatedAt}}' ${volume})"`,
        ].join("\n");
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

// One line per container of the project, its one-off `run` containers
// left out: service, state, exit code and health status.
const inspectScript = `
ids="$(docker ps --all --quiet --no-trunc --filter "label=com.docker.compose.project=$1")"
[ -z "$ids" ] || docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}\t{{index .Config.Labels "com.docker.compose.oneoff"}}\t{{.State.Status}}\t{{.State.ExitCode}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}' $ids
`;

function parseContainerRows(value: string) {
  return value.split("\n").flatMap((line) => {
    const [service, oneoff, state, exitCode, health] = line.split("\t");
    if (!service || !state || oneoff === "True") return [];
    return [
      {
        service,
        state,
        exitCode: /^\d+$/.test(exitCode ?? "") ? Number(exitCode) : undefined,
        // A stopped container keeps its last health status, often
        // unhealthy from the stop itself; like Compose, report health only
        // while the container runs.
        health: (state === "running" && health) || undefined,
      },
    ];
  });
}

function sha256(...parts: string[]) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
