import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type {
  PreviewExecutionPlan,
  RuntimeSelection,
} from "@blame/preview-runtime";
import { previewEnvironmentValueRejection } from "@blame/preview-runtime";
import {
  ComposeEngine,
  renderCompose,
  type CommandResult,
  type DockerHost,
  type WorkspaceFingerprints,
} from "@blame/preview-runtime/compose";
import { runnerError } from "../protocol/runner-errors.js";
import { measureRunnerPhase } from "../performance-measure.js";
import {
  appendSetupLog,
  startComposeLogCollectors,
  stopComposeLogCollectors,
} from "../logs/compose-log-collector.js";
import {
  snapshotWorkspace,
  type WorkspaceSnapshot,
} from "../workspace/workspace-snapshot.js";
import {
  dockerEnvironment,
  dockerReady,
  ensureDockerEngine,
  shutdownDockerEngine,
} from "./docker-engine.js";

// The sandbox side of the shared Compose engine: the sandbox is its own
// Docker host, the workspace snapshot gives the setup and image fingerprints.

const proxyCertificatePath =
  "/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem";
const stateDirectory = "/var/lib/blame/runtime";

const sandboxHost: DockerHost = {
  run: (command, args, options) => runCommand(command, args, options?.onOutput),
  readFile: (path) => readFile(path, "utf8").catch(() => undefined),
  async writeFile(path, content) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600, flush: true });
  },
};

const engine = new ComposeEngine({
  host: sandboxHost,
  stateDirectory,
  measure: measureRunnerPhase,
  // Setup output reaches the run logs even when the services never start.
  log: appendSetupLog,
});

export class ComposeSupervisor {
  async prepare(
    plan: PreviewExecutionPlan,
    browserBindingUrls: Record<string, string>,
  ) {
    validateComposePlan(plan);
    if (!existsSync(proxyCertificatePath)) {
      throw runnerError(
        "VERCEL_PROXY_CA_MISSING",
        "The Vercel proxy CA is required by the nested Compose engine.",
      );
    }
    const identity = await projectIdentity();
    const rendered = renderCompose(plan, {
      kind: "sandbox",
      projectUser: `${identity.uid}:${identity.gid}`,
      proxyCertificatePath,
      browserBindingUrls,
    });
    await ensureDockerEngine();
    await engine.prepare(rendered, identity);
  }

  async start(plan: PreviewExecutionPlan, selection: RuntimeSelection) {
    const services = selection.serviceIds ?? [];
    if (!services.length) {
      await stopComposeLogCollectors();
      return;
    }
    await ensureDockerEngine();
    await engine.start(plan, services, snapshotFingerprints());
    await startComposeLogCollectors(services);
  }

  async warm(plan: PreviewExecutionPlan) {
    await engine.warm(plan, snapshotFingerprints());
  }

  async stop() {
    await stopComposeLogCollectors();
    if (!(await dockerReady())) return;
    await engine.stop({ remove: true });
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
    return (await engine.inspect(plan)).map(({ id, running, healthy }) => ({
      id,
      running,
      healthy,
    }));
  }

  execInService(serviceId: string, args: string[]) {
    return engine.execInService(serviceId, args);
  }

  targets() {
    return engine.targets();
  }
}

// One workspace snapshot per start backs both fingerprints.
function snapshotFingerprints(): WorkspaceFingerprints {
  let snapshot: Promise<WorkspaceSnapshot> | undefined;
  const files = async () => (await (snapshot ??= snapshotWorkspace())).files;
  return {
    async lockfiles() {
      const entries = Object.entries(await files())
        .filter(([path]) =>
          /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|poetry\.lock|Cargo\.lock|uv\.lock)$/.test(
            path,
          ),
        )
        .sort(([left], [right]) => left.localeCompare(right));
      return sha256(JSON.stringify(entries));
    },
    async buildContext(context) {
      const prefix = `${context.replace(/^\.?\//, "").replace(/\\/g, "/")}/`;
      const entries = Object.entries(await files())
        .filter(
          ([path]) =>
            prefix === "./" ||
            prefix === "/" ||
            path === prefix.slice(0, -1) ||
            path.startsWith(prefix),
        )
        .sort(([left], [right]) => left.localeCompare(right));
      return sha256(JSON.stringify(entries));
    },
  };
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
  const value = async (flag: string) =>
    Number((await runCommand("id", [flag, "blame-project"])).stdout.trim());
  const uid = await value("-u");
  const gid = await value("-g");
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) {
    throw runnerError(
      "PROJECT_IDENTITY_MISSING",
      "Sandbox project identity is unavailable.",
    );
  }
  return { uid, gid };
}

function runCommand(
  executable: string,
  args: string[],
  onOutput?: (chunk: string) => void,
) {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...dockerEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const keep = (current: string, chunk: string) =>
      `${current}${chunk}`.slice(-4 * 1024 * 1024);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = keep(stdout, chunk);
      onOutput?.(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = keep(stderr, chunk);
      onOutput?.(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr }),
    );
  });
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
