import { chown, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  componentPreviewSandbox,
  parseComponentPreviewSandboxCursor,
  parseComponentPreviewSandboxStart,
  type ComponentPreviewSandboxOutput,
} from "@blame/preview-runtime";
import {
  GatewaySupervisor,
  type GatewayInstance,
} from "../gateway/gateway-supervisor.js";
import type { GatewayRoute } from "../gateway/http-forwarder.js";
import { runnerError } from "../protocol/runner-errors.js";
import { runtimePaths } from "../runtime-paths.js";
import type { RunnerRuntimeState } from "../runtime-state.js";
import type { ComposeSupervisor } from "../supervisor/compose-supervisor.js";

// open_component_preview in a cloud preview. Blame's temporary Vite server
// runs in a one-off container of a preview service, with the same image,
// workspace and node_modules volumes, its port published on the sandbox's
// loopback only. A gateway of its own puts it behind a capability on the
// reserved port; the preview's containers and gateway keep running as they
// are. The container is kept once it exits, so its last output still tells
// why, and removed on the next start or at stop.

export const componentPreviewContainerName = "blame-component-preview";

export const componentPreviewGatewayInstance: GatewayInstance = {
  configPath: runtimePaths.componentPreviewGatewayConfig,
  logPath: "/var/log/blame/component-preview-gateway.log",
  pidPath: "/run/blame/component-preview-gateway.pid",
};

const excludePattern = "*.blame-preview.*";
const excludeHeading = "# Temporary component previews (Blame)";
// Each poll returns at most this much of each stream.
const outputLimit = 256 * 1024;

type Identity = { gid: number; uid: number };
type ComposeCommands = Pick<ComposeSupervisor, "composeCommand" | "docker">;
type Gateway = Pick<GatewaySupervisor, "start" | "stop">;

export type ComponentPreviewSupervisorDependencies = {
  compose: ComposeCommands;
  gateway?: Gateway;
  // Runs before each container start.
  prepareSandbox: () => Promise<void>;
  // The capability verification key the preview's gateway uses too.
  publicKey?: () => Promise<string>;
};

export type ComponentPreviewStartResult = {
  // Identity the gateway checks capabilities against.
  generation: number;
  sandboxPort: number;
  serviceId: string;
  sessionId: string;
};

export class ComponentPreviewSupervisor {
  private readonly compose: ComposeCommands;
  private readonly gateway: Gateway;
  private readonly prepareSandbox: () => Promise<void>;
  private readonly publicKey: () => Promise<string>;

  constructor(dependencies: ComponentPreviewSupervisorDependencies) {
    this.compose = dependencies.compose;
    this.gateway =
      dependencies.gateway ??
      new GatewaySupervisor(componentPreviewGatewayInstance);
    this.prepareSandbox = dependencies.prepareSandbox;
    this.publicKey =
      dependencies.publicKey ??
      (() => readFile(runtimePaths.capabilityPublicKey, "utf8"));
  }

  async start(
    state: RunnerRuntimeState,
    request: { nodeArguments: unknown; port: unknown; routeId: unknown },
  ): Promise<ComponentPreviewStartResult> {
    const parsed = parseComponentPreviewSandboxStart(request);
    if (!parsed.ok)
      throw runnerError("INVALID_COMPONENT_PREVIEW", parsed.message);
    if (
      typeof request.routeId !== "string" ||
      !/^[a-f0-9]{40}$/.test(request.routeId)
    )
      throw runnerError(
        "INVALID_COMPONENT_PREVIEW",
        "The component preview route is invalid.",
      );
    if (!state.running || !state.plan)
      throw runnerError(
        "ENGINE_NOT_RUNNING",
        "Start the cloud preview before rendering a component.",
      );
    const { nodeArguments, port } = parsed.value;
    if (
      state.plan.networking.gatewayListeners.some(
        ({ sandboxPort }) => sandboxPort === port,
      )
    )
      throw portInUse(port);
    const serviceId = componentPreviewServiceId(state);
    if (!serviceId)
      throw runnerError(
        "COMPONENT_PREVIEW_UNAVAILABLE",
        "The cloud preview has no service that runs the project's code.",
      );
    await this.stop();
    await this.prepareSandbox();
    const result = await this.compose.composeCommand(
      componentPreviewRunArguments({ nodeArguments, port, serviceId }),
    );
    if (result.exitCode !== 0) {
      const detail = lastLines(`${result.stderr}\n${result.stdout}`);
      if (/port is already allocated|address already in use/iu.test(detail))
        throw portInUse(port);
      throw runnerError(
        "COMPONENT_PREVIEW_START_FAILED",
        `The component preview container did not start in the ${serviceId} service: ${detail}`,
      );
    }
    try {
      await this.gateway.start({
        publicKeyPem: await this.publicKey(),
        routes: [
          componentPreviewGatewayRoute(state, {
            port,
            routeId: request.routeId,
          }),
        ],
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
    return {
      generation: state.generation,
      sandboxPort: componentPreviewSandbox.gatewayPort,
      serviceId,
      sessionId: state.sessionId,
    };
  }

  // What the server wrote since the cursor, and whether it still runs.
  async output(cursorValue: unknown): Promise<ComponentPreviewSandboxOutput> {
    const cursor = parseComponentPreviewSandboxCursor(cursorValue);
    if (!cursor)
      throw runnerError(
        "INVALID_COMPONENT_PREVIEW",
        "The component preview output cursor is invalid.",
      );
    const [logs, inspected] = await Promise.all([
      this.compose.docker(["logs", componentPreviewContainerName]),
      this.compose.docker([
        "inspect",
        "--format",
        "{{.State.Running}}",
        componentPreviewContainerName,
      ]),
    ]);
    if (logs.exitCode !== 0)
      return { cursor, running: false, stderr: "", stdout: "" };
    return {
      cursor: { stderr: logs.stderr.length, stdout: logs.stdout.length },
      running: inspected.exitCode === 0 && inspected.stdout.trim() === "true",
      stderr: unread(logs.stderr, cursor.stderr),
      stdout: unread(logs.stdout, cursor.stdout),
    };
  }

  async stop() {
    await this.compose.docker(["rm", "--force", componentPreviewContainerName]);
    await this.gateway.stop();
    return { stopped: true };
  }
}

// Blame's own Vite folder, writable by the project user the containers run
// as, and the Git exclusion of the preview files in the sandbox's checkout,
// which a source import may have recreated.
export async function prepareComponentPreviewSandbox(
  projectIdentity: () => Promise<Identity>,
) {
  const identity = await projectIdentity();
  await mkdir(componentPreviewSandbox.toolkitRoot, {
    recursive: true,
    mode: 0o755,
  });
  await chown(componentPreviewSandbox.toolkitRoot, identity.uid, identity.gid);
  await excludeComponentPreviewFiles(runtimePaths.workspace);
}

// The service whose image and volumes run the project's code: the browser
// preview's, else the first preview service, else the first worker.
export function componentPreviewServiceId(
  state: Pick<RunnerRuntimeState, "plan" | "selection">,
) {
  const services = state.plan?.services ?? [];
  const primary = state.selection?.primaryRoute?.serviceId;
  return (
    services.find(({ id }) => id === primary)?.id ??
    services.find(({ kind }) => kind === "preview")?.id ??
    services.find(({ kind }) => kind === "worker")?.id
  );
}

export function componentPreviewRunArguments(input: {
  nodeArguments: string[];
  port: number;
  serviceId: string;
}) {
  const { toolkitRoot } = componentPreviewSandbox;
  return [
    "run",
    "--detach",
    "--no-deps",
    "-T",
    "--name",
    componentPreviewContainerName,
    "--publish",
    `127.0.0.1:${input.port}:${input.port}`,
    "--volume",
    `${toolkitRoot}:${toolkitRoot}`,
    "--entrypoint",
    "node",
    input.serviceId,
    ...input.nodeArguments,
  ];
}

export function componentPreviewGatewayRoute(
  state: Pick<RunnerRuntimeState, "generation" | "sessionId">,
  input: { port: number; routeId: string },
): GatewayRoute {
  return {
    sessionId: state.sessionId,
    routeId: input.routeId,
    serviceId: componentPreviewSandbox.serviceId,
    endpointId: componentPreviewSandbox.endpointId,
    generation: state.generation,
    logicalPort: input.port,
    sandboxPort: componentPreviewSandbox.gatewayPort,
    targetHost: "127.0.0.1",
    targetPort: input.port,
  };
}

// The content of .git/info/exclude with the preview pattern, or undefined
// when it already has it.
export function componentPreviewExcludeContent(current: string) {
  const lines = current.split(/\r?\n/u).map((line) => line.trim());
  if (lines.includes(excludePattern)) return undefined;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  return `${current}${separator}${excludeHeading}\n${excludePattern}\n`;
}

export async function excludeComponentPreviewFiles(workspace: string) {
  const gitDirectory = join(workspace, ".git");
  if (!(await stat(gitDirectory).catch(() => undefined))?.isDirectory())
    return false;
  const file = join(gitDirectory, "info", "exclude");
  const current = await readFile(file, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  const next = componentPreviewExcludeContent(current);
  if (next === undefined) return false;
  await mkdir(join(gitDirectory, "info"), { recursive: true });
  await writeFile(file, next);
  return true;
}

function unread(output: string, cursor: number) {
  const fresh = output.slice(Math.min(cursor, output.length));
  return fresh.length > outputLimit ? fresh.slice(-outputLimit) : fresh;
}

function lastLines(output: string) {
  return (
    output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-6)
      .join("\n") || "no output"
  );
}

function portInUse(port: number) {
  return runnerError(
    "COMPONENT_PREVIEW_PORT_IN_USE",
    `Port ${port} is already in use in the sandbox.`,
  );
}
