import {
  parsePreviewManifest,
  type PreviewManifest,
  type PreviewManifestEndpoint,
  type PreviewManifestService,
} from "@blame/preview-contract";
import type {
  CompatibilityRequirement,
  PreviewExecutionPlan,
  ProbePlan,
  ServiceEndpointPlan,
  ServiceLaunchPlan,
} from "../domain/execution-plan.js";
import { defaultProbeTimeoutMs } from "../domain/functional-probes.js";
import { PreviewRuntimeError } from "../domain/preview-errors.js";
import { endpointRouteKey } from "../domain/endpoint-map.js";
import {
  mergeEnvironmentPlan,
  type EnvironmentPlanEntry,
} from "../domain/environment-plan.js";

export type ManifestCompilerOptions = {
  gatewayPortStart?: number;
  compatibilityHints?: Array<
    | {
        type: "server-localhost";
        consumerServiceId: string;
        targetServiceId: string;
        port: number;
      }
    | { type: "client-localhost"; targetServiceId: string; port: number }
    | { type: "websocket" }
  >;
};

export function compilePreviewManifest(
  input: PreviewManifest | unknown,
  options: ManifestCompilerOptions = {},
): PreviewExecutionPlan {
  let manifest: PreviewManifest;
  try {
    manifest = parsePreviewManifest(input);
  } catch (error) {
    throw new PreviewRuntimeError(
      {
        code: "INVALID_MANIFEST",
        message:
          error instanceof Error ? error.message : "Invalid preview manifest.",
        retryable: false,
      },
      { cause: error },
    );
  }
  const serviceIds = new Set(manifest.services.map(({ id }) => id));
  const services = manifest.services.map((service) =>
    compileService(service, serviceIds),
  );
  const hints = options.compatibilityHints ?? [];
  assertCompatibilityHints(hints, services);
  const publishedEndpoints = browserEndpoints(manifest.services);
  const environmentPlan = compileEnvironmentPlan(manifest);
  const gatewayStart = options.gatewayPortStart ?? 43_000;
  const gatewayListeners = publishedEndpoints.map(
    ({ service, endpoint }, index) => ({
      routeKey: endpointRouteKey(service.id, endpoint.id),
      serviceId: service.id,
      endpointId: endpoint.id,
      logicalPort: endpoint.port,
      sandboxPort: gatewayStart + index,
      targetHost: service.id,
      targetPort: endpoint.port,
      basePathMode: "root" as const,
    }),
  );
  const serverLocalhostHints = hints.filter(
    (
      hint,
    ): hint is Extract<(typeof hints)[number], { type: "server-localhost" }> =>
      hint.type === "server-localhost",
  );
  const loopbackGroups = compileLoopbackGroups(serverLocalhostHints);
  const clientLocalhost = hints.some(
    (hint) => hint.type === "client-localhost",
  );
  const crossOriginBrowserBinding = manifest.services.some((service) =>
    (service.bindings ?? []).some(
      (binding) =>
        binding.exposure === "browser" && binding.source.service !== service.id,
    ),
  );
  const incompatibilityReasons = [
    ...(clientLocalhost
      ? ["Client code uses a declared localhost endpoint."]
      : []),
    ...(crossOriginBrowserBinding
      ? ["A browser binding targets a separately authenticated origin."]
      : []),
  ];
  const requiresWebSockets = hints.some((hint) => hint.type === "websocket");
  const detectedCompatibility: CompatibilityRequirement[] = [
    { type: "bidirectional-sync" },
    { type: "container-engine" },
    ...loopbackGroups.map(({ serviceIds }) => ({
      type: "shared-loopback" as const,
      serviceIds,
    })),
    ...(requiresWebSockets ? [{ type: "websocket" as const }] : []),
    ...incompatibilityReasons.map((reason) => ({
      type: "integrated-preview" as const,
      reason,
    })),
  ];
  return {
    version: 2,
    workspaceRoot: "/workspace",
    setup: orderedSetupTasks(manifest).map((task) => ({
      id: task.id,
      container: structuredClone(task.container),
      workingDir: task.workingDir || "/workspace",
      command: task.command,
      entrypoint: task.entrypoint ? [...task.entrypoint] : undefined,
      runAs: task.runAs ?? "host",
      environment: { ...(task.environment ?? {}) },
      dependsOn: [...(task.dependsOn ?? [])],
    })),
    services,
    caches: manifest.caches.map((cache) => ({ ...cache })),
    probes: manifest.probes.map((probe) => compileProbe(manifest, probe)),
    environmentPlan,
    networking: {
      gatewayListeners,
      loopbackGroups,
      publishedPortCount: gatewayListeners.length,
      browserBindingCount: manifest.services.reduce(
        (count, service) =>
          count +
          (service.bindings ?? []).filter(
            ({ exposure }) => exposure === "browser",
          ).length,
        0,
      ),
      requiresSharedLoopback: loopbackGroups.length > 0,
      requiresWebSockets,
      integratedPreviewRequired: incompatibilityReasons.length > 0,
      incompatibilityReasons,
    },
    detectedCompatibility,
  };
}

function compileEnvironmentPlan(manifest: PreviewManifest) {
  const entries: EnvironmentPlanEntry[] = [];
  for (const task of manifest.setup) {
    for (const key of Object.keys(task.environment ?? {})) {
      entries.push(environmentEntry(key, "setup", "manifest"));
    }
  }
  for (const service of manifest.services) {
    for (const key of Object.keys(service.environment ?? {})) {
      entries.push({
        ...environmentEntry(key, "service", "manifest"),
        serviceId: service.id,
      });
    }
    for (const binding of service.bindings ?? []) {
      entries.push({
        ...environmentEntry(
          binding.target.key,
          binding.exposure === "browser" ? "client-public" : "ssr",
          "runtime-binding",
        ),
        classification:
          binding.exposure === "browser" ? "public-build-time" : "non-secret",
        serviceId: service.id,
      });
    }
  }
  return mergeEnvironmentPlan(entries);
}

function environmentEntry(
  key: string,
  scope: EnvironmentPlanEntry["scope"],
  source: EnvironmentPlanEntry["source"],
): EnvironmentPlanEntry {
  return {
    key,
    scope,
    source,
    classification: "non-secret",
    delivery: "literal",
    snapshot: "never",
  };
}

// An empty acceptedStatuses list means "anything below 500"; see
// probeStatusAccepted.
function compileProbe(
  manifest: PreviewManifest,
  probe: PreviewManifest["probes"][number],
): ProbePlan {
  const endpoint = manifest.services
    .find(({ id }) => id === probe.target.service)
    ?.endpoints.find(({ id }) => id === probe.target.endpoint);
  return {
    id: probe.id,
    from: probe.from,
    target: {
      serviceId: probe.target.service,
      endpointId: probe.target.endpoint,
      path: probe.target.path ?? endpoint?.healthcheck?.path ?? "/",
    },
    type: probe.type,
    acceptedStatuses: [...(probe.acceptedStatuses ?? [])],
    timeoutMs: probe.timeoutMs ?? defaultProbeTimeoutMs,
    required: probe.required ?? true,
  };
}

function compileService(
  service: PreviewManifestService,
  serviceIds: Set<string>,
): ServiceLaunchPlan {
  return {
    id: service.id,
    kind: service.kind,
    container: structuredClone(service.container),
    workingDir: service.workingDir || "/workspace",
    command: service.command,
    entrypoint: service.entrypoint ? [...service.entrypoint] : undefined,
    user: service.user,
    environment: { ...(service.environment ?? {}) },
    dependsOn: [
      ...new Set([
        ...(service.dependsOn ?? []).filter((id) => serviceIds.has(id)),
        ...(service.bindings ?? [])
          .filter(({ exposure }) => exposure === "server")
          .map(({ source }) => source.service),
      ]),
    ],
    endpoints: serviceEndpoints(service).map(compileEndpoint),
    bindings: (service.bindings ?? []).map((binding) => ({
      targetKey: binding.target.key,
      sourceServiceId: binding.source.service,
      sourceEndpointId: binding.source.endpoint,
      exposure: binding.exposure,
      format: binding.format ?? "url",
      path: binding.path ?? "",
    })),
  };
}

function orderedSetupTasks(manifest: PreviewManifest) {
  const tasks = new Map(manifest.setup.map((task) => [task.id, task]));
  const pending = new Set(tasks.keys());
  const ordered: PreviewManifest["setup"] = [];
  while (pending.size) {
    const ready = [...pending].filter((id) =>
      (tasks.get(id)?.dependsOn ?? []).every(
        (dependency) => !pending.has(dependency),
      ),
    );
    if (!ready.length) {
      throw new PreviewRuntimeError({
        code: "INVALID_MANIFEST",
        message: "Setup task dependencies contain a cycle.",
        retryable: false,
      });
    }
    for (const id of ready) {
      pending.delete(id);
      ordered.push(tasks.get(id)!);
    }
  }
  return ordered;
}

function compileEndpoint(
  endpoint: PreviewManifestEndpoint,
): ServiceEndpointPlan {
  return {
    id: endpoint.id,
    protocol: endpoint.protocol,
    port: endpoint.port,
    healthcheck: endpoint.healthcheck ? { ...endpoint.healthcheck } : undefined,
  };
}

function serviceEndpoints(
  service: PreviewManifestService,
): PreviewManifestEndpoint[] {
  return service.endpoints;
}

function browserEndpoints(services: PreviewManifestService[]) {
  const required = new Set<string>();
  for (const service of services) {
    if (service.kind === "preview") {
      for (const endpoint of serviceEndpoints(service)) {
        if (endpoint.protocol !== "tcp")
          required.add(`${service.id}:${endpoint.id}`);
      }
    }
    for (const binding of service.bindings ?? []) {
      if (binding.exposure === "browser") {
        required.add(`${binding.source.service}:${binding.source.endpoint}`);
      }
    }
  }
  return services.flatMap((service) =>
    serviceEndpoints(service)
      .filter(
        (endpoint) =>
          endpoint.protocol !== "tcp" &&
          required.has(`${service.id}:${endpoint.id}`),
      )
      .map((endpoint) => ({ service, endpoint })),
  );
}

function compileLoopbackGroups(
  hints: Array<{
    type: "server-localhost";
    consumerServiceId: string;
    targetServiceId: string;
    port: number;
  }>,
) {
  const adjacency = new Map<string, Set<string>>();
  const portsByService = new Map<string, Set<number>>();
  for (const hint of hints) {
    connect(adjacency, hint.consumerServiceId, hint.targetServiceId);
    connect(adjacency, hint.targetServiceId, hint.consumerServiceId);
    for (const id of [hint.consumerServiceId, hint.targetServiceId]) {
      const ports = portsByService.get(id) ?? new Set<number>();
      ports.add(hint.port);
      portsByService.set(id, ports);
    }
  }
  const visited = new Set<string>();
  const groups = [];
  for (const root of [...adjacency.keys()].sort()) {
    if (visited.has(root)) continue;
    const pending = [root];
    const serviceIds: string[] = [];
    const logicalPorts = new Set<number>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      serviceIds.push(id);
      portsByService.get(id)?.forEach((port) => logicalPorts.add(port));
      pending.push(
        ...[...(adjacency.get(id) ?? [])].filter((item) => !visited.has(item)),
      );
    }
    serviceIds.sort();
    groups.push({
      id: `loopback:${serviceIds.join(":")}`,
      serviceIds,
      logicalPorts: [...logicalPorts].sort((left, right) => left - right),
    });
  }
  return groups;
}

function assertCompatibilityHints(
  hints: NonNullable<ManifestCompilerOptions["compatibilityHints"]>,
  services: ServiceLaunchPlan[],
) {
  for (const hint of hints) {
    if (hint.type === "websocket") continue;
    const target = services.find(({ id }) => id === hint.targetServiceId);
    if (!target || !target.endpoints.some(({ port }) => port === hint.port)) {
      throw new PreviewRuntimeError({
        code: "INVALID_MANIFEST",
        message: `Compatibility hint targets an unknown endpoint ${hint.targetServiceId}:${hint.port}.`,
        retryable: false,
      });
    }
    if (
      hint.type === "server-localhost" &&
      !services.some(({ id }) => id === hint.consumerServiceId)
    ) {
      throw new PreviewRuntimeError({
        code: "INVALID_MANIFEST",
        message: `Compatibility hint has an unknown consumer ${hint.consumerServiceId}.`,
        retryable: false,
      });
    }
  }
}

function connect(
  adjacency: Map<string, Set<string>>,
  source: string,
  target: string,
) {
  const targets = adjacency.get(source) ?? new Set<string>();
  targets.add(target);
  adjacency.set(source, targets);
}
