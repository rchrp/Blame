import { spawn } from "node:child_process";
import { chown, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  composeCacheVolumeName,
  renderCloudCompose,
  type ComposeRenderResult,
} from "./compose-renderer.js";
import { runtimePaths } from "../runtime-paths.js";
import type {
  PreviewExecutionPlan,
  RuntimeSelection,
} from "@blame/preview-runtime";
import { previewEnvironmentValueRejection } from "@blame/preview-runtime";
import { runnerError } from "../protocol/runner-errors.js";
import { measureRunnerPhase } from "../performance-measure.js";
import {
  startComposeLogCollectors,
  stopComposeLogCollectors,
} from "../logs/compose-log-collector.js";
import { selectedSetupTasks } from "./runtime-selection.js";
import { createHash } from "node:crypto";
import {
  snapshotWorkspace,
  type WorkspaceSnapshot,
} from "../workspace/workspace-snapshot.js";
import {
  setupCacheFingerprintMatches,
  writeSetupCacheFingerprint,
} from "./setup-cache-fingerprints.js";
import {
  dockerDataRoot,
  dockerEnvironment,
  dockerReady,
  ensureDockerEngine,
  shutdownDockerEngine,
} from "./docker-engine.js";
import {
  ensureCacheVolume,
  resolveCacheVolumeMountpoint,
} from "./cache-volume.js";
import { composeCommandFailureDetail } from "./compose-command-detail.js";

const composeFingerprintPath = "/var/lib/blame/runtime/compose-fingerprint";

export class ComposeSupervisor {
  async prepare(
    plan: PreviewExecutionPlan,
    browserBindingUrls: Record<string, string>,
  ) {
    return measureRunnerPhase("compose.prepare", async () => {
      validateComposePlan(plan);
      const identity = await projectIdentity();
      const rendered = renderCloudCompose(plan, browserBindingUrls, {
        projectUser: `${identity.uid}:${identity.gid}`,
      });
      const fingerprint = composeFingerprint(rendered);
      const engine = this.ensureDocker();
      if (await preparedComposeMatches(fingerprint)) {
        await measureRunnerPhase(
          "compose.prepare.cached",
          async () => undefined,
        );
        await engine;
        await this.prepareCaches(plan, identity);
        return;
      }
      await mkdir(dirname(runtimePaths.composeFile), {
        recursive: true,
        mode: 0o700,
      });
      await Promise.all([
        engine,
        writeFile(runtimePaths.composeFile, rendered.yaml, {
          mode: 0o600,
          flush: true,
        }),
        writeFile(
          `${runtimePaths.composeFile}.targets.json`,
          JSON.stringify(rendered.targets),
          {
            mode: 0o600,
            flush: true,
          },
        ),
      ]);
      await this.prepareCaches(plan, identity);
      await writeFile(composeFingerprintPath, fingerprint, {
        mode: 0o600,
        flush: true,
      });
    });
  }

  async start(plan: PreviewExecutionPlan, selection: RuntimeSelection) {
    return measureRunnerPhase("services.start", async () => {
      const services = selection.serviceIds ?? [];
      if (!services.length) {
        await stopComposeLogCollectors();
        return;
      }
      await this.ensureDocker();
      const snapshot = await snapshotWorkspace();
      await this.runSetup(plan, services, snapshot);
      await this.prepareImages(plan, services, snapshot);
      await command("docker", [
        "compose",
        "-f",
        runtimePaths.composeFile,
        "up",
        "-d",
        "--remove-orphans",
        "--no-build",
        ...services,
      ]);
      await startComposeLogCollectors(services);
    });
  }

  async warm(plan: PreviewExecutionPlan) {
    return measureRunnerPhase("compose.build", async () => {
      const serviceIds = plan.services.map(({ id }) => id);
      const snapshot = await snapshotWorkspace();
      await this.runSetup(plan, serviceIds, snapshot);
      await this.prepareImages(
        plan,
        [...plan.setup.map(({ id }) => `setup-${id}`), ...serviceIds],
        snapshot,
      );
    });
  }

  async stop() {
    await stopComposeLogCollectors();
    if (!(await dockerReady())) return;
    await command("docker", [
      "compose",
      "-f",
      runtimePaths.composeFile,
      "down",
      "--remove-orphans",
      "--timeout",
      "15",
    ]);
  }

  async shutdownEngine() {
    await shutdownDockerEngine();
  }

  async inspect(plan: PreviewExecutionPlan) {
    if (!(await dockerReady())) {
      return plan.services.map(({ id }) => ({
        id,
        running: false,
        healthy: false,
      }));
    }
    const result = await command(
      "docker",
      ["compose", "-f", runtimePaths.composeFile, "ps", "--format", "json"],
      true,
    );
    const rows = result.stdout
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      }) as Array<{ Service?: string; State?: string; Health?: string }>;
    return plan.services.map(({ id }) => {
      const row = rows.find(({ Service }) => Service === id);
      return {
        id,
        running: row?.State === "running",
        healthy: row?.Health ? row.Health === "healthy" : undefined,
      };
    });
  }

  async targets(): Promise<ComposeRenderResult["targets"]> {
    return JSON.parse(
      await readFile(`${runtimePaths.composeFile}.targets.json`, "utf8"),
    );
  }

  private async ensureDocker() {
    return ensureDockerEngine();
  }

  private async prepareCaches(
    plan: PreviewExecutionPlan,
    identity: { uid: number; gid: number },
  ) {
    for (const cache of plan.caches) {
      const volumeName = composeCacheVolumeName(cache.name);
      const mountpoint = await ensureCacheVolume(volumeName, {
        create: async (name) => {
          await command("docker", ["volume", "create", name]);
        },
        remove: async (name) => {
          await command("docker", ["volume", "rm", "--force", name]);
        },
        mountpoint: cacheVolumeMountpoint,
      });
      await chown(mountpoint, identity.uid, identity.gid);
    }
  }

  private async runSetup(
    plan: PreviewExecutionPlan,
    selectedServices: string[],
    snapshot: WorkspaceSnapshot,
  ) {
    const stamps = await readSetupStamps();
    const lockfileHash = relevantLockfileHash(snapshot.files);
    const cacheMountpoints = await Promise.all(
      plan.caches.map(({ name }) =>
        cacheVolumeMountpoint(composeCacheVolumeName(name)),
      ),
    );
    for (const task of selectedSetupTasks(plan, selectedServices)) {
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(task))
        .update("\0")
        .update(lockfileHash)
        .digest("hex");
      if (
        stamps[task.id] === fingerprint &&
        (await setupCacheFingerprintMatches(
          cacheMountpoints,
          task.id,
          fingerprint,
        ))
      ) {
        continue;
      }
      const dependencies = task.dependsOn.filter((id) =>
        plan.services.some((service) => service.id === id),
      );
      await this.prepareImages(
        plan,
        [`setup-${task.id}`, ...dependencies],
        snapshot,
      );
      if (dependencies.length) {
        await command("docker", [
          "compose",
          "-f",
          runtimePaths.composeFile,
          "up",
          "-d",
          "--no-build",
          ...dependencies,
        ]);
      }
      await measureRunnerPhase("dependencies.install", () =>
        command("docker", [
          "compose",
          "-f",
          runtimePaths.composeFile,
          "run",
          "--rm",
          `setup-${task.id}`,
        ]),
      );
      await writeSetupCacheFingerprint(cacheMountpoints, task.id, fingerprint);
      stamps[task.id] = fingerprint;
      await writeSetupStamps(stamps);
    }
  }

  private async prepareImages(
    plan: PreviewExecutionPlan,
    serviceIds: string[],
    snapshot: WorkspaceSnapshot,
  ) {
    if (!serviceIds.length) return;
    const stamps = await readImageStamps();
    const pending = serviceIds.filter((id) => {
      const fingerprint = imageFingerprint(plan, id, snapshot.files);
      return stamps[id] !== fingerprint;
    });
    if (!pending.length) return;
    await measureRunnerPhase("compose.pull", () =>
      command("docker", [
        "compose",
        "-f",
        runtimePaths.composeFile,
        "pull",
        "--policy",
        "missing",
        "--ignore-buildable",
        ...pending,
      ]),
    );
    const buildable = pending.filter((id) => {
      const item = imageItem(plan, id);
      return Boolean(item?.container && "build" in item.container);
    });
    if (buildable.length) {
      await measureRunnerPhase("compose.build", () =>
        command("docker", [
          "compose",
          "-f",
          runtimePaths.composeFile,
          "build",
          ...buildable,
        ]),
      );
    }
    for (const id of pending)
      stamps[id] = imageFingerprint(plan, id, snapshot.files);
    await writeImageStamps(stamps);
  }
}

const setupStampPath = "/var/lib/blame/runtime/setup-fingerprints.json";
const imageStampPath = "/var/lib/blame/runtime/image-fingerprints.json";

async function readSetupStamps() {
  try {
    return JSON.parse(await readFile(setupStampPath, "utf8")) as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

async function writeSetupStamps(stamps: Record<string, string>) {
  await mkdir(dirname(setupStampPath), { recursive: true, mode: 0o700 });
  await writeFile(setupStampPath, JSON.stringify(stamps), {
    mode: 0o600,
    flush: true,
  });
}

function relevantLockfileHash(files: WorkspaceSnapshot["files"]) {
  const entries = Object.entries(files)
    .filter(([path]) =>
      /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|poetry\.lock|Cargo\.lock|uv\.lock)$/.test(
        path,
      ),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function composeFingerprint(rendered: ComposeRenderResult) {
  return createHash("sha256")
    .update(rendered.yaml)
    .update("\0")
    .update(JSON.stringify(rendered.targets))
    .digest("hex");
}

async function preparedComposeMatches(fingerprint: string) {
  const [stored, composeFile, targets] = await Promise.all([
    readFile(composeFingerprintPath, "utf8").catch(() => ""),
    readFile(runtimePaths.composeFile).catch(() => undefined),
    readFile(`${runtimePaths.composeFile}.targets.json`).catch(() => undefined),
  ]);
  return stored === fingerprint && Boolean(composeFile) && Boolean(targets);
}

async function readImageStamps() {
  try {
    return JSON.parse(await readFile(imageStampPath, "utf8")) as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

async function writeImageStamps(stamps: Record<string, string>) {
  await mkdir(dirname(imageStampPath), { recursive: true, mode: 0o700 });
  await writeFile(imageStampPath, JSON.stringify(stamps), {
    mode: 0o600,
    flush: true,
  });
}

function imageFingerprint(
  plan: PreviewExecutionPlan,
  id: string,
  files: Record<string, { sha256: string }>,
) {
  const item = imageItem(plan, id);
  if (!item) return "missing";
  const context = "build" in item.container && item.container.build?.context;
  const contextPrefix = context
    ? `${context.replace(/^\.?\//, "").replace(/\\/g, "/")}/`
    : undefined;
  const contextFiles = contextPrefix
    ? Object.entries(files)
        .filter(
          ([path]) =>
            path === contextPrefix.slice(0, -1) ||
            path.startsWith(contextPrefix),
        )
        .sort(([left], [right]) => left.localeCompare(right))
    : [];
  return createHash("sha256")
    .update(JSON.stringify(item))
    .update("\0")
    .update(JSON.stringify(contextFiles))
    .digest("hex");
}

function imageItem(plan: PreviewExecutionPlan, id: string) {
  const setupId = id.startsWith("setup-")
    ? id.slice("setup-".length)
    : undefined;
  return setupId
    ? plan.setup.find(({ id: candidate }) => candidate === setupId)
    : plan.services.find(({ id: candidate }) => candidate === id);
}

async function cacheVolumeMountpoint(volumeName: string) {
  const inspected = await command("docker", [
    "volume",
    "inspect",
    "--format",
    "{{.Mountpoint}}",
    volumeName,
  ]);
  return resolveCacheVolumeMountpoint(
    volumeName,
    inspected.stdout.trim(),
    dockerVolumeRoot(),
  );
}

function dockerVolumeRoot() {
  return `${dockerDataRoot}/volumes/`;
}

function validateComposePlan(plan: PreviewExecutionPlan) {
  for (const item of [...plan.setup, ...plan.services]) {
    for (const [key, value] of Object.entries(item.environment)) {
      const rejection = previewEnvironmentValueRejection(value);
      if (rejection) {
        throw runnerError(
          "RAW_SECRET_REJECTED",
          `Environment value ${key} ${rejection}.`,
        );
      }
    }
  }
}

async function projectIdentity() {
  const uid = Number(
    (await command("id", ["-u", "blame-project"])).stdout.trim(),
  );
  const gid = Number(
    (await command("id", ["-g", "blame-project"])).stdout.trim(),
  );
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) {
    throw runnerError(
      "PROJECT_IDENTITY_MISSING",
      "Sandbox project identity is unavailable.",
    );
  }
  return { uid, gid };
}

async function command(
  executable: string,
  args: string[],
  allowFailure = false,
) {
  const result = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...dockerEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on(
        "data",
        (chunk) => (stdout = `${stdout}${chunk}`.slice(-4 * 1024 * 1024)),
      );
    child.stderr
      .setEncoding("utf8")
      .on(
        "data",
        (chunk) => (stderr = `${stderr}${chunk}`.slice(-4 * 1024 * 1024)),
      );
    child.once("error", reject);
    child.once("exit", (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr }),
    );
  });
  if (!allowFailure && result.exitCode !== 0) {
    const detail = composeCommandFailureDetail(result.stderr, result.stdout);
    throw runnerError(
      "COMPOSE_COMMAND_FAILED",
      `Compose command failed: ${detail}`,
    );
  }
  return result;
}
