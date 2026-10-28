import type { PreviewExecutionPlan } from "@blame/preview-runtime";
import {
  ComposeEngine,
  installTtydCommand,
  probeServices,
  runFunctionalProbes,
  type DockerHost,
  type EnginePhase,
  type ServiceState,
} from "@blame/preview-runtime/compose";
import {
  previewRunConfigurationServiceIds,
  selectedPreviewRunConfiguration,
  shouldStartBrowserPreview,
} from "../../preview-run-state.ts";
import { previewFailureLogExcerpt } from "../../preview-readiness.ts";
import { rm } from "../../workspace-runtime.ts";
import {
  compileLocalPreviewPlan,
  errorText,
  LocalPreviewError,
  localPreviewPaths,
  readLocalPreviewManifest,
  readLocalRunConfigurations,
  readLocalRuntimeState,
} from "./local-preview-files.ts";
import { previewEndpoint, renderLocalPreview } from "./local-preview-render.ts";
import { blameRuntimeDockerHost } from "./vm-docker-host.ts";

// Runs a worktree's local preview on the shared Compose engine: Docker
// orders the services by health, the engine skips setup that is still
// valid, and readiness and functional probes use the cloud rules.

const previewResponseTimeoutMs = 120_000;
const previewPollIntervalMs = 1_000;

export type LocalPreviewRunOptions = {
  /** Output of the engine and its commands, for the run log. */
  log?: (chunk: string) => void;
  /** A step that means something to people, shown while it starts. */
  step?: (step: string) => void;
  /** How long a phase took, for the timing log. */
  timing?: (label: string, durationMs: number) => void;
  /** False once the preview should no longer start. */
  wanted?: () => Promise<boolean>;
};

const phaseSteps: Record<EnginePhase, string | undefined> = {
  "compose.prepare": undefined,
  "compose.pull": "Downloading container images",
  "compose.build": "Building container images",
  // Each setup task names itself in the log instead.
  "dependencies.install": undefined,
  "services.start": "Starting the app services",
};

let dockerHost: DockerHost = blameRuntimeDockerHost;

/** Replaces the Blame Runtime with another Docker host, for tests. */
export function useLocalDockerHost(host: DockerHost) {
  dockerHost = host;
}

export function localPreviewEngine(
  worktree: string,
  options: LocalPreviewRunOptions = {},
) {
  return new ComposeEngine({
    host: dockerHost,
    stateDirectory: localPreviewPaths(worktree).engineState,
    log: (chunk) => {
      options.log?.(chunk);
      if (chunk.includes("Waiting for the app window")) options.step?.("Waiting for the app window");
      const setup = /^Running setup (.+)\.$/m.exec(chunk);
      if (setup) options.step?.(`Running setup task ${setup[1]}`);
    },
    measure: async (phase, action) => {
      const step = phaseSteps[phase];
      if (step) options.step?.(step);
      const startedAt = Date.now();
      try {
        return await action();
      } finally {
        options.timing?.(phase, Date.now() - startedAt);
      }
    },
  });
}

export type LocalPreviewContext = Awaited<
  ReturnType<typeof localPreviewContext>
>;

/** The manifest, plan and selected run configuration of a worktree. */
export async function localPreviewContext(worktree: string) {
  const manifest = await readLocalPreviewManifest(worktree);
  if (!manifest) {
    throw new LocalPreviewError(
      "preview_manifest_invalid",
      "A canonical preview manifest is required",
    );
  }
  const [configurations, state] = await Promise.all([
    readLocalRunConfigurations(worktree),
    readLocalRuntimeState(worktree),
  ]);
  const plan = compileLocalPreviewPlan(manifest);
  const selected = selectedPreviewRunConfiguration(configurations, state);
  return { manifest, plan, configurations, state, selected };
}

/** The services a run configuration starts, with their dependencies. */
export function selectedServiceIds(context: LocalPreviewContext) {
  if (!context.selected) return [];
  const ids = new Set(context.plan.services.map(({ id }) => id));
  return previewRunConfigurationServiceIds(
    context.selected,
    context.manifest,
  ).filter((id) => ids.has(id));
}

/**
 * Starts the selected run configuration and waits until it answers.
 * Returns the browser preview URL when the configuration has one.
 */
export async function startLocalPreview(
  worktree: string,
  options: LocalPreviewRunOptions = {},
) {
  const context = await localPreviewContext(worktree);
  const engine = localPreviewEngine(worktree, options);
  const serviceIds = selectedServiceIds(context);
  const ownPorts = await runningPorts(engine, context.plan);
  const local = await renderLocalPreview({
    worktree,
    plan: context.plan,
    selected: context.selected,
    ownPorts,
  });
  if (context.plan.tools?.ttyd && dockerHost === blameRuntimeDockerHost) {
    const installed = await dockerHost.run("sh", ["-c", installTtydCommand()], {
      timeoutMs: 120000,
    });
    if (installed.exitCode)
      throw new Error(
        "Terminal tools could not be installed. Check the runtime connection and try again.",
      );
  }
  await engine.prepare(local.rendered, local.owner);
  if (!(await wanted(options))) return undefined;
  await stopOtherServices(engine, context.plan, serviceIds);
  await engine.start(context.plan, serviceIds, {
    lockfiles: async () => local.dependencyKey,
  });
  if (!serviceIds.length || !(await wanted(options))) return undefined;
  const targets = local.rendered.targets;
  options.step?.("Waiting for the app to answer");
  await waitUntilReady(engine, context.plan, serviceIds, targets, options);
  const url = shouldStartBrowserPreview(
    context.configurations,
    context.state,
    context.manifest,
  )
    ? previewUrl(context, local.hostPorts)
    : undefined;
  if (url) await waitForAnswer(engine, context.plan, serviceIds, url, options);
  await runFunctionalProbes({
    plan: context.plan,
    serviceIds,
    targets,
    exec: (serviceId, command) => engine.execInService(serviceId, command),
  });
  return url;
}

/**
 * Prepares a later start in the background: images and dependency
 * installs, with no service left running.
 */
export async function prefetchLocalPreview(
  worktree: string,
  options: LocalPreviewRunOptions = {},
) {
  const context = await localPreviewContext(worktree);
  const engine = localPreviewEngine(worktree, options);
  const local = await renderLocalPreview({
    worktree,
    plan: context.plan,
    selected: context.selected,
    ownPorts: await runningPorts(engine, context.plan),
  });
  await engine.prepare(local.rendered, local.owner);
  await engine.prefetch(context.plan, {
    lockfiles: async () => local.dependencyKey,
  });
}

export async function stopLocalPreview(
  worktree: string,
  serviceIds?: string[],
) {
  const { stopSurfaceTerminals } =
    await import("../../preview-surfaces/surface-sessions.ts");
  stopSurfaceTerminals(undefined, worktree);
  const engine = localPreviewEngine(worktree);
  if (!(await engine.prepared())) return;
  if (!serviceIds) return engine.stop();
  if (!serviceIds.length) return;
  await engine.compose(["stop", "--timeout", "5", ...serviceIds]);
}

/** Removes the preview's containers, network and own volumes. */
export async function removeLocalPreview(worktree: string) {
  await localPreviewEngine(worktree).remove();
  await rm(localPreviewPaths(worktree).engineState);
}

export async function localPreviewServices(
  worktree: string,
): Promise<ServiceState[]> {
  try {
    const { plan } = await localPreviewContext(worktree);
    return await localPreviewEngine(worktree).inspect(plan);
  } catch {
    return [];
  }
}

/** The browser preview URL while its service runs. */
export async function localPreviewUrl(worktree: string) {
  const engine = localPreviewEngine(worktree);
  const project = await engine.prepared();
  if (!project) return undefined;
  const context = await localPreviewContext(worktree).catch(() => undefined);
  if (!context) return undefined;
  if (
    !shouldStartBrowserPreview(
      context.configurations,
      context.state,
      context.manifest,
    )
  )
    return undefined;
  const endpoint = previewEndpoint(context.plan, context.selected);
  if (!endpoint) return undefined;
  const states = await engine.inspect(context.plan);
  if (!states.find(({ id }) => id === endpoint.serviceId)?.running)
    return undefined;
  return previewUrl(
    context,
    Object.fromEntries(
      Object.entries(project.targets).map(([key, { port }]) => [key, port]),
    ),
  );
}

/** Published endpoints of the running preview, for the preview bridge. */
export async function localPreviewEndpoints(worktree: string) {
  const engine = localPreviewEngine(worktree);
  const project = await engine.prepared();
  const context = await localPreviewContext(worktree).catch(() => undefined);
  if (!project || !context) return { routes: [], primary: undefined };
  const routes = context.plan.services.flatMap((service) =>
    service.endpoints
      .filter(({ protocol }) => protocol !== "tcp")
      .flatMap((endpoint) => {
        const target = project.targets[`${service.id}:${endpoint.id}`];
        return target
          ? [
              {
                serviceId: service.id,
                ...(service.surface ? { surface: service.surface.type } : {}),
                endpointId: endpoint.id,
                protocol: endpoint.protocol as "http" | "https",
                port: target.port,
              },
            ]
          : [];
      }),
  );
  const primary = previewEndpoint(context.plan, context.selected);
  return { routes, primary };
}

/** Whether the running preview still passes its functional probes. */
export async function localPreviewProbesPass(worktree: string) {
  try {
    const context = await localPreviewContext(worktree);
    const engine = localPreviewEngine(worktree);
    await runFunctionalProbes({
      plan: context.plan,
      serviceIds: selectedServiceIds(context),
      targets: await engine.targets(),
      exec: (serviceId, command) => engine.execInService(serviceId, command),
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether every service of the selected run configuration can still run. */
export async function localPreviewHealthy(worktree: string) {
  try {
    const context = await localPreviewContext(worktree);
    const selected = new Set(selectedServiceIds(context));
    const states = (
      await localPreviewEngine(worktree).inspect(context.plan)
    ).filter(({ id }) => selected.has(id));
    return (
      states.length > 0 &&
      states.every(({ running, health }) => running && health !== "unhealthy")
    );
  } catch {
    return false;
  }
}

export async function localPreviewLogs(
  worktree: string,
  serviceId: string | undefined,
  options: { tail?: number; timeoutMs?: number } = {},
) {
  const engine = localPreviewEngine(worktree);
  if (!(await engine.prepared())) return undefined;
  return engine.logs(serviceId, options);
}

export async function followLocalPreviewLogs(
  worktree: string,
  serviceId: string | undefined,
  onOutput: (chunk: string) => void,
  signal: AbortSignal,
) {
  const engine = localPreviewEngine(worktree);
  if (!(await engine.prepared())) return undefined;
  return engine.logs(serviceId, { tail: 120, follow: true, onOutput, signal });
}

async function runningPorts(engine: ComposeEngine, plan: PreviewExecutionPlan) {
  const project = await engine.prepared();
  if (!project) return new Set<number>();
  const states = await engine.inspect(plan).catch(() => []);
  return new Set(
    Object.entries(project.targets)
      .filter(([key]) =>
        states.some(({ id, running }) => running && key.startsWith(`${id}:`)),
      )
      .map(([, { port }]) => port),
  );
}

async function stopOtherServices(
  engine: ComposeEngine,
  plan: PreviewExecutionPlan,
  serviceIds: string[],
) {
  const active = new Set(serviceIds);
  const running = (await engine.inspect(plan))
    .filter(({ id, running }) => running && !active.has(id))
    .map(({ id }) => id);
  if (running.length)
    await engine.compose(["stop", "--timeout", "5", ...running]);
}

// Docker already waited for every container healthcheck; services whose
// image has no runtime to script one are probed from here.
async function waitUntilReady(
  engine: ComposeEngine,
  plan: PreviewExecutionPlan,
  serviceIds: string[],
  targets: Parameters<typeof probeServices>[1],
  options: LocalPreviewRunOptions,
) {
  const selected = {
    services: plan.services.filter(({ id }) => serviceIds.includes(id)),
  };
  const results = await probeServices(selected, targets);
  const failed = results.find(({ healthy }) => healthy === false);
  if (!failed || !(await wanted(options))) return;
  throw new LocalPreviewError(
    "preview_response_timeout",
    await withLogExcerpt(
      engine,
      failed.id,
      `Preview service ${failed.id} did not become ready`,
    ),
  );
}

async function waitForAnswer(
  engine: ComposeEngine,
  plan: PreviewExecutionPlan,
  serviceIds: string[],
  url: string,
  options: LocalPreviewRunOptions,
) {
  const deadline = Date.now() + previewResponseTimeoutMs;
  while (Date.now() < deadline) {
    if (await answers(url)) return;
    if (!(await wanted(options))) return;
    const stopped = (await engine.inspect(plan)).find(
      ({ id, running, state }) =>
        serviceIds.includes(id) && !running && state && state !== "created",
    );
    if (stopped) {
      throw new LocalPreviewError(
        "preview_container_stopped",
        await withLogExcerpt(
          engine,
          stopped.id,
          `Preview container ${stopped.id} stopped (${stopped.state})`,
        ),
      );
    }
    await delay(previewPollIntervalMs);
  }
  throw new LocalPreviewError(
    "preview_response_timeout",
    `Preview did not respond within ${previewResponseTimeoutMs / 1_000} seconds`,
  );
}

async function answers(url: string) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status < 500;
  } catch {
    return false;
  }
}

function previewUrl(
  context: LocalPreviewContext,
  hostPorts: Record<string, number>,
) {
  const endpoint = previewEndpoint(context.plan, context.selected);
  if (!endpoint) return undefined;
  const port = hostPorts[`${endpoint.serviceId}:${endpoint.endpoint.id}`];
  if (!port) return undefined;
  const protocol = endpoint.endpoint.protocol === "https" ? "https" : "http";
  const path = endpoint.endpoint.healthcheck?.path ?? "/";
  return `${protocol}://localhost:${port}${path.startsWith("/") ? path : `/${path}`}`;
}

async function withLogExcerpt(
  engine: ComposeEngine,
  serviceId: string,
  message: string,
) {
  const logs = await engine
    .logs(serviceId, { tail: 120, timeoutMs: 15_000 })
    .catch(() => undefined);
  const excerpt = previewFailureLogExcerpt(
    `${logs?.stdout ?? ""}\n${logs?.stderr ?? ""}`,
  );
  return excerpt ? `${message}: ${excerpt}` : message;
}

async function wanted(options: LocalPreviewRunOptions) {
  return options.wanted ? options.wanted() : true;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export { errorText };
