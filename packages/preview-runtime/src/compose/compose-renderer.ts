import { posix } from "node:path";
import { stringify } from "yaml";
import type {
  ContainerPlan,
  PreviewExecutionPlan,
  ServiceBindingPlan,
  ServiceEndpointPlan,
  ServiceLaunchPlan,
  SetupTaskPlan,
} from "../domain/execution-plan.js";
import { ComposeEngineError } from "./docker-host.js";
import { serviceHealthcheck } from "./compose-healthcheck.js";
import {
  cacheVolumes,
  packageNodeModulesVolumes,
  projectName,
  safeId,
  type ComposeTarget,
  type EngineVolume,
  type MountedVolume,
} from "./compose-target.js";

// The one translation of an execution plan into a Compose project, for local
// and cloud previews alike. Setup tasks become one-shot services in the
// `setup` profile, run by the engine before the services start; services
// depend on each other with Compose conditions, so Docker starts each one
// once its dependencies are healthy.

const relayPortStart = 44_000;
const runtimeHome = "/tmp/blame-home";
export const setupProfile = "setup";

export type EndpointTarget = { host: "127.0.0.1"; port: number };

export type RenderedCompose = {
  projectName: string;
  yaml: string;
  /** Where the Docker host reaches each endpoint, keyed `service:endpoint`. */
  targets: Record<string, EndpointTarget>;
  /** Volumes the engine creates and owns before Compose runs. */
  volumes: EngineVolume[];
  /** The engine volumes each service mounts. */
  serviceVolumes: Record<string, string[]>;
};

export class ComposeRenderError extends ComposeEngineError {
  constructor(code: string, message: string) {
    super(code, message, "INVALID_MANIFEST");
  }
}

export function setupServiceId(taskId: string) {
  return `setup-${taskId}`;
}

/** Every endpoint the engine publishes on the Docker host. */
export function publishedEndpointKeys(plan: PreviewExecutionPlan) {
  return plan.services.flatMap((service) =>
    service.endpoints.map(({ id }) => endpointKey(service.id, id)),
  );
}

export function renderCompose(
  plan: PreviewExecutionPlan,
  target: ComposeTarget,
): RenderedCompose {
  const targets = endpointTargets(plan, target);
  const anchors = loopbackAnchors(plan);
  const healthchecks = new Map(
    plan.services.map((service) => [service.id, serviceHealthcheck(service)]),
  );
  const mounted = new Map<string, MountedVolume>();
  const serviceVolumes: Record<string, string[]> = {};
  const context = {
    plan,
    target,
    targets,
    anchors,
    healthchecks,
    mounted,
    serviceVolumes,
  };
  const services = Object.fromEntries([
    ...plan.setup.map((task) => [
      setupServiceId(task.id),
      setupService(task, context),
    ]),
    ...plan.services.map((service) => [
      service.id,
      runtimeService(service, context),
    ]),
  ]);
  const volumes = [...mounted.values()].sort((left, right) =>
    left.alias.localeCompare(right.alias),
  );
  const document = {
    name: projectName(target),
    services,
    ...(volumes.length
      ? {
          volumes: Object.fromEntries(
            volumes.map(({ alias, name }) => [alias, { name, external: true }]),
          ),
        }
      : {}),
  };
  return {
    projectName: projectName(target),
    yaml: stringify(document, { lineWidth: 0 }),
    targets: Object.fromEntries(targets),
    volumes: volumes.map(({ name, owner, shared, setupMarker }) => ({
      name,
      owner,
      shared,
      setupMarker,
    })),
    serviceVolumes,
  };
}

type RenderContext = {
  plan: PreviewExecutionPlan;
  target: ComposeTarget;
  targets: Map<string, EndpointTarget>;
  anchors: Map<string, string>;
  healthchecks: Map<string, ReturnType<typeof serviceHealthcheck>>;
  mounted: Map<string, MountedVolume>;
  serviceVolumes: Record<string, string[]>;
};

function setupService(task: SetupTaskPlan, context: RenderContext) {
  return container(context, {
    ...containerSource(task.container, task.id, context.target),
    profiles: [setupProfile],
    entrypoint: task.entrypoint,
    command: shellCommand(task.command),
    working_dir: task.workingDir,
    environment: containerEnvironment(task.environment, context.target),
    depends_on: dependencyConditions(
      task.dependsOn.filter((id) =>
        context.plan.services.some((service) => service.id === id),
      ),
      context,
    ),
    volumes: serviceVolumes(task, setupServiceId(task.id), context, true),
    user: task.runAs === "root" ? "0:0" : context.target.projectUser,
    restart: "no",
  });
}

function runtimeService(service: ServiceLaunchPlan, context: RenderContext) {
  const anchor = context.anchors.get(service.id);
  const sharesLoopback = Boolean(anchor && anchor !== service.id);
  return container(context, {
    ...containerSource(service.container, service.id, context.target),
    entrypoint: service.entrypoint,
    command: service.command ? shellCommand(service.command) : undefined,
    working_dir:
      service.kind === "dependency" && !service.command
        ? undefined
        : service.workingDir,
    environment: serviceEnvironment(service, context),
    depends_on: dependencyConditions(
      [...service.dependsOn, ...(sharesLoopback ? [anchor!] : [])],
      context,
    ),
    network_mode: sharesLoopback ? `service:${anchor}` : undefined,
    ports: sharesLoopback ? undefined : publishedPorts(service, context),
    volumes: serviceVolumes(
      service,
      service.id,
      context,
      needsWorkspace(service),
    ),
    user: serviceUser(service, context.target),
    healthcheck: context.healthchecks.get(service.id),
    restart:
      context.target.kind === "sandbox" ? "unless-stopped" : "on-failure:3",
  });
}

// Project code runs as the user that owns the workspace. Locally, an image
// that only runs a dependency, such as a database, keeps its own user: its
// entrypoint prepares its data directory. The sandbox drops every
// capability, so it runs all containers as the project user.
function serviceUser(service: ServiceLaunchPlan, target: ComposeTarget) {
  if (service.user) return service.user;
  if (target.kind === "local" && !needsWorkspace(service)) return undefined;
  return target.projectUser;
}

// `init` gives every container a PID 1 that forwards signals, so services
// stop in a moment instead of waiting for the kill timeout.
function container(context: RenderContext, service: Record<string, unknown>) {
  const hardened =
    context.target.kind === "sandbox"
      ? {
          cap_drop: ["ALL"],
          security_opt: ["no-new-privileges:true"],
          pids_limit: 512,
          read_only: false,
          tmpfs: ["/tmp:rw,noexec,nosuid,size=256m"],
        }
      : {};
  return withoutEmpty({
    ...service,
    init: true,
    stop_grace_period: "5s",
    labels: { "blame.preview": "true" },
    ...hardened,
  });
}

function needsWorkspace(service: ServiceLaunchPlan) {
  return (
    service.kind !== "dependency" ||
    (Boolean(service.command) && service.workingDir.startsWith("/workspace"))
  );
}

function serviceEnvironment(
  service: ServiceLaunchPlan,
  context: RenderContext,
) {
  const environment = containerEnvironment(service.environment, context.target);
  for (const binding of service.bindings) {
    environment[binding.targetKey] = composeLiteral(
      bindingValue(binding, service, context),
    );
  }
  return environment;
}

function containerEnvironment(
  environment: Record<string, string>,
  target: ComposeTarget,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      HOME: runtimeHome,
      XDG_CACHE_HOME: `${runtimeHome}/.cache`,
      ...environment,
      ...(target.kind === "sandbox"
        ? { NODE_EXTRA_CA_CERTS: target.proxyCertificatePath }
        : {}),
    }).map(([key, value]) => [key, composeLiteral(value)]),
  );
}

function bindingValue(
  binding: ServiceBindingPlan,
  consumer: ServiceLaunchPlan,
  context: RenderContext,
) {
  const source = context.plan.services.find(
    ({ id }) => id === binding.sourceServiceId,
  );
  const endpoint = source?.endpoints.find(
    ({ id }) => id === binding.sourceEndpointId,
  );
  if (!source || !endpoint)
    throw new ComposeRenderError("INVALID_PLAN", "Binding source is missing.");
  if (binding.exposure === "browser") {
    const value = browserUrl(source, endpoint, binding, context.target);
    const url = new URL(value);
    return formattedBinding(
      binding,
      url.hostname,
      url.port || (url.protocol === "https:" ? "443" : "80"),
      value,
    );
  }
  const anchor = context.anchors.get(consumer.id);
  const host =
    anchor && anchor === context.anchors.get(source.id)
      ? "localhost"
      : source.id;
  return formattedBinding(
    binding,
    host,
    String(endpoint.port),
    `${endpoint.protocol}://${host}:${endpoint.port}${binding.path}`,
  );
}

function browserUrl(
  source: ServiceLaunchPlan,
  endpoint: ServiceEndpointPlan,
  binding: ServiceBindingPlan,
  target: ComposeTarget,
) {
  const key = endpointKey(source.id, endpoint.id);
  if (target.kind === "local") {
    const port = target.hostPorts[key];
    if (!port) throw missingHostPort(key);
    const protocol = endpoint.protocol === "https" ? "https" : "http";
    return `${protocol}://localhost:${port}${binding.path}`;
  }
  const publicUrl = target.browserBindingUrls[key];
  if (!publicUrl) {
    throw new ComposeRenderError(
      "BROWSER_BINDING_UNAVAILABLE",
      "Browser endpoint URL is unavailable.",
    );
  }
  return `${publicUrl.replace(/\/$/, "")}${binding.path}`;
}

function formattedBinding(
  binding: ServiceBindingPlan,
  host: string,
  port: string,
  url: string,
) {
  if (binding.format === "host") return host;
  if (binding.format === "port") return port;
  if (binding.format === "host-port") return `${host}:${port}`;
  return url;
}

function dependencyConditions(ids: string[], context: RenderContext) {
  const unique = [...new Set(ids)];
  if (!unique.length) return undefined;
  return Object.fromEntries(
    unique.map((id) => [
      id,
      {
        condition: context.healthchecks.get(id)
          ? "service_healthy"
          : "service_started",
      },
    ]),
  );
}

// Services sharing a loopback publish through their anchor, which owns the
// network namespace.
function publishedPorts(service: ServiceLaunchPlan, context: RenderContext) {
  const ports = context.plan.services
    .filter(
      (candidate) =>
        (context.anchors.get(candidate.id) ?? candidate.id) === service.id,
    )
    .flatMap((candidate) =>
      candidate.endpoints.map((endpoint) => {
        const target = context.targets.get(
          endpointKey(candidate.id, endpoint.id),
        )!;
        return `127.0.0.1:${target.port}:${endpoint.port}`;
      }),
    );
  return ports.length ? ports : undefined;
}

function endpointTargets(plan: PreviewExecutionPlan, target: ComposeTarget) {
  const targets = new Map<string, EndpointTarget>();
  let relayPort = relayPortStart;
  for (const key of publishedEndpointKeys(plan)) {
    if (target.kind === "sandbox") {
      targets.set(key, { host: "127.0.0.1", port: relayPort++ });
      continue;
    }
    const port = target.hostPorts[key];
    if (!Number.isSafeInteger(port) || port < 1) throw missingHostPort(key);
    targets.set(key, { host: "127.0.0.1", port });
  }
  return targets;
}

// Caches are mounted everywhere: a manifest also declares database data
// directories as caches. A service that does not run project code gets
// neither the workspace nor its dependency volumes.
function serviceVolumes(
  item: ServiceLaunchPlan | SetupTaskPlan,
  serviceId: string,
  context: RenderContext,
  workspace: boolean,
) {
  const { plan, target } = context;
  const volumes = [
    ...cacheVolumes(plan, target),
    ...(workspace ? packageNodeModulesVolumes(plan, target, item) : []),
  ];
  for (const volume of volumes) context.mounted.set(volume.alias, volume);
  context.serviceVolumes[serviceId] = volumes.map(({ name }) => name);
  const source = !workspace
    ? []
    : target.kind === "sandbox"
      ? ["/workspace:/workspace:rw", "/workspace/.git:/workspace/.git:ro"]
      : [`${target.workspacePath}:/workspace`];
  const files =
    workspace && target.kind === "local"
      ? (target.fileMounts ?? []).map(
          ({ source: path, target: file }) =>
            `${path}:${posix.join("/workspace", file)}:ro`,
        )
      : [];
  return nonEmpty([
    ...source,
    ...baseVolumes(target),
    ...volumes.map(({ alias, target: path }) => `${alias}:${path}`),
    ...files,
  ]);
}

function baseVolumes(target: ComposeTarget) {
  return target.kind === "sandbox"
    ? [`${target.proxyCertificatePath}:${target.proxyCertificatePath}:ro`]
    : [];
}

function containerSource(
  source: ContainerPlan,
  id: string,
  target: ComposeTarget,
) {
  if (source.image) return { image: source.image };
  if (!source.build) {
    throw new ComposeRenderError(
      "CONTAINER_SOURCE_REQUIRED",
      `Compose service ${id} requires an image or build.`,
    );
  }
  const relative = posix.normalize(source.build.context.replace(/\\/g, "/"));
  const dockerfile = source.build.dockerfile;
  if (
    relative.startsWith("/") ||
    relative === ".." ||
    relative.startsWith("../") ||
    dockerfile.startsWith("/") ||
    dockerfile.split("/").includes("..")
  ) {
    throw new ComposeRenderError(
      "INVALID_BUILD_CONTEXT",
      `Compose build ${id} escapes the workspace.`,
    );
  }
  const root = target.kind === "sandbox" ? "/workspace" : target.workspacePath;
  return {
    build: withoutEmpty({
      context: relative === "." ? root : posix.join(root, relative),
      dockerfile,
      target: source.build.target,
    }),
  };
}

function shellCommand(command: string) {
  return ["/bin/sh", "-lc", composeLiteral(command)];
}

// Compose interpolates `$NAME`; the plan's values are literal, except for an
// already escaped `$$`.
export function composeLiteral(value: string) {
  return value.replace(/(?<!\$)\$(?!\$)/g, () => "$$");
}

function loopbackAnchors(plan: PreviewExecutionPlan) {
  const anchors = new Map<string, string>();
  for (const group of plan.networking.loopbackGroups) {
    const anchor = group.serviceIds[0];
    if (!anchor) continue;
    for (const serviceId of group.serviceIds) {
      const existing = anchors.get(serviceId);
      if (existing && existing !== anchor) {
        throw new ComposeRenderError(
          "AMBIGUOUS_LOOPBACK_GROUP",
          "Overlapping loopback groups are unsupported.",
        );
      }
      anchors.set(serviceId, anchor);
    }
  }
  return anchors;
}

function missingHostPort(key: string) {
  return new ComposeRenderError(
    "HOST_PORT_MISSING",
    `No host port is allocated for endpoint ${key}.`,
  );
}

export function endpointKey(serviceId: string, endpointId: string) {
  return `${serviceId}:${endpointId}`;
}

export { safeId };

function nonEmpty<T>(values: T[]) {
  return values.length ? values : undefined;
}

function withoutEmpty(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
