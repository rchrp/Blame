import type {
  PreviewManifest,
  PreviewManifestBinding,
  PreviewManifestCache,
  PreviewManifestContainer,
  PreviewManifestEndpoint,
  PreviewManifestEndpointHealthcheck,
  PreviewManifestEnvironment,
  PreviewManifestProbe,
  PreviewManifestProject,
  PreviewManifestRisk,
  PreviewManifestService,
  PreviewManifestServiceKind,
  PreviewManifestSetupTask,
} from "./types.js";
import { previewEnvironmentValueRejection } from "./environment-security.js";
import { parseSurface, validateSurfaces } from "./parser-surfaces.js";
import { parseDevices, validateDevices } from "./parser-devices.js";

const serviceKinds = new Set<PreviewManifestServiceKind>([
  "preview",
  "dependency",
  "worker",
]);
const confidenceValues = new Set(["low", "medium", "high"]);
const riskLevels = new Set(["low", "medium", "high"]);
const endpointProtocols = new Set(["http", "https", "tcp"]);
const bindingExposures = new Set(["server", "browser"]);
const bindingFormats = new Set(["url", "host", "port", "host-port"]);
const unsafeCommandPatterns = [
  /\brm\s+-rf\s+\/(?:\s|$)/,
  /\bsudo\b/,
  /\bchmod\s+-R\s+777\s+\/(?:\s|$)/,
  /\bcurl\b[\s\S]*\|\s*(?:sh|bash)\b/,
  /\bwget\b[\s\S]*\|\s*(?:sh|bash)\b/,
  /\bssh-keygen\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-fdx\b/,
  /\b--privileged\b/,
  /\bnetwork_mode\s*:\s*host\b/,
  /\/var\/run\/docker\.sock/,
  /\bdocker\.sock\b/,
];

export function parsePreviewManifest(value: unknown): PreviewManifest {
  if (!isRecord(value)) throw new Error("previewManifest must be an object");
  assertOnlyKeys(value, "previewManifest", [
    "confidence",
    "project",
    "setup",
    "services",
    "caches",
    "risks",
    "probes",
    "devices",
  ]);
  const manifest: PreviewManifest = {
    confidence: parseConfidence(value.confidence),
    project: parseProject(value.project),
    setup: parseSetupTasks(value.setup),
    services: parseServices(value.services),
    caches: parseCaches(value.caches),
    risks: parseRisks(value.risks),
    probes: parseProbes(value.probes),
    ...(value.devices === undefined
      ? {}
      : {
          devices: parseDevices(value.devices, {
            environment: parseEnvironment,
            command: validateCommand,
            path: workspaceRelativePath,
          }),
        }),
  };
  validatePreviewManifest(manifest);
  return manifest;
}

export function validatePreviewManifest(manifest: PreviewManifest) {
  validateSurfaces(manifest.services);
  validateDevices(
    parseDevices(manifest.devices ?? [], {
      environment: parseEnvironment,
      command: validateCommand,
      path: workspaceRelativePath,
    }),
    manifest.services,
    [
      ...manifest.setup.map((t) => t.id),
      ...manifest.services.flatMap((s) =>
        s.surface?.type === "display" ? [s.id, `${s.id}__display`] : [s.id],
      ),
    ],
  );
  uniqueIds(
    "setup task",
    manifest.setup.map(({ id }) => id),
  );
  uniqueIds(
    "service",
    manifest.services.map(({ id }) => id),
  );
  uniqueIds("runtime item", [
    ...manifest.setup.map(({ id }) => id),
    ...manifest.services.map(({ id }) => id),
  ]);
  uniqueIds(
    "cache",
    manifest.caches.map(({ name }) => name),
  );
  uniqueIds(
    "probe",
    (manifest.probes ?? []).map(({ id }) => id),
  );
  const knownIds = new Set([
    ...manifest.setup.map(({ id }) => id),
    ...manifest.services.map(({ id }) => id),
  ]);
  for (const task of manifest.setup) validateSetupTask(task, knownIds);
  for (const service of manifest.services) validateService(service, knownIds);
  for (const cache of manifest.caches) validateCache(cache);
  validateTopology(manifest);
}

function parseConfidence(value: unknown) {
  if (typeof value !== "string" || !confidenceValues.has(value)) {
    throw new Error("previewManifest confidence is invalid");
  }
  return value as PreviewManifest["confidence"];
}

function parseProject(value: unknown): PreviewManifestProject {
  if (value === undefined) return {};
  if (!isRecord(value))
    throw new Error("previewManifest project must be an object");
  assertOnlyKeys(value, "project", ["root", "detectedStack", "confidence"]);
  return {
    root: optionalString(value.root),
    detectedStack: parseOptionalStrings(
      value.detectedStack,
      "project.detectedStack",
    ),
    confidence:
      value.confidence === undefined
        ? undefined
        : parseConfidence(value.confidence),
  };
}

function parseSetupTasks(value: unknown) {
  limitedArray(value, "setup", 50);
  return value.map(parseSetupTask);
}

function parseSetupTask(value: unknown): PreviewManifestSetupTask {
  if (!isRecord(value))
    throw new Error("previewManifest setup task must be an object");
  assertOnlyKeys(value, "setup task", [
    "id",
    "container",
    "workingDir",
    "command",
    "entrypoint",
    "runAs",
    "environment",
    "dependsOn",
  ]);
  return {
    id: requiredString(value.id, "setup.id"),
    container: parseContainer(value.container, "setup.container"),
    workingDir: optionalString(value.workingDir),
    command: requiredString(value.command, "setup.command"),
    entrypoint: parseOptionalCommand(value.entrypoint, "setup.entrypoint"),
    runAs: parseRunAs(value.runAs),
    environment: parseEnvironment(value.environment, "setup.environment"),
    dependsOn: parseOptionalStrings(value.dependsOn, "setup.dependsOn"),
  };
}

function parseServices(value: unknown) {
  limitedArray(value, "services", 50);
  return value.map(parseService);
}

function parseService(value: unknown): PreviewManifestService {
  if (!isRecord(value))
    throw new Error("previewManifest service must be an object");
  assertOnlyKeys(value, "service", [
    "id",
    "kind",
    "container",
    "workingDir",
    "command",
    "entrypoint",
    "user",
    "environment",
    "dependsOn",
    "endpoints",
    "bindings",
    "surface",
  ]);
  return {
    id: requiredString(value.id, "service.id"),
    kind: serviceKind(value.kind),
    container: parseContainer(value.container, "service.container"),
    workingDir: optionalString(value.workingDir),
    command: optionalString(value.command),
    entrypoint: parseOptionalCommand(value.entrypoint, "service.entrypoint"),
    user: optionalString(value.user),
    environment: parseEnvironment(value.environment, "service.environment"),
    dependsOn: parseOptionalStrings(value.dependsOn, "service.dependsOn"),
    endpoints: parseEndpoints(value.endpoints),
    bindings: parseBindings(value.bindings),
    ...(value.surface === undefined
      ? {}
      : { surface: parseSurface(value.surface) }),
  };
}

function parseContainer(
  value: unknown,
  field: string,
): PreviewManifestContainer {
  if (!isRecord(value))
    throw new Error(`previewManifest ${field} must be an object`);
  assertOnlyKeys(value, field, ["image", "build"]);
  const image = optionalString(value.image);
  const build =
    value.build === undefined
      ? undefined
      : parseBuild(value.build, `${field}.build`);
  if (Boolean(image) === Boolean(build)) {
    throw new Error(
      `previewManifest ${field} must define exactly one of image or build`,
    );
  }
  if (image) validateImage(image, field);
  return image ? { image } : { build: build! };
}

function parseBuild(value: unknown, field: string) {
  if (!isRecord(value))
    throw new Error(`previewManifest ${field} must be an object`);
  assertOnlyKeys(value, field, ["context", "dockerfile", "target"]);
  return {
    context: workspaceRelativePath(value.context, `${field}.context`),
    dockerfile: workspaceRelativePath(value.dockerfile, `${field}.dockerfile`),
    target:
      value.target === undefined
        ? undefined
        : safeBuildTarget(value.target, `${field}.target`),
  };
}

function parseEndpoints(value: unknown): PreviewManifestEndpoint[] {
  limitedArray(value, "endpoints", 20);
  return value.map(parseEndpoint);
}

function parseEndpoint(value: unknown): PreviewManifestEndpoint {
  if (!isRecord(value))
    throw new Error("previewManifest endpoint must be an object");
  assertOnlyKeys(value, "endpoint", ["id", "protocol", "port", "healthcheck"]);
  const protocol = requiredString(value.protocol, "endpoint.protocol");
  if (!endpointProtocols.has(protocol)) {
    throw new Error("previewManifest endpoint protocol is invalid");
  }
  return {
    id: requiredString(value.id, "endpoint.id"),
    protocol: protocol as PreviewManifestEndpoint["protocol"],
    port: portValue(value.port, "endpoint.port"),
    healthcheck: parseEndpointHealthcheck(value.healthcheck),
  };
}

function parseEndpointHealthcheck(
  value: unknown,
): PreviewManifestEndpointHealthcheck | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value))
    throw new Error("previewManifest endpoint healthcheck must be an object");
  assertOnlyKeys(value, "endpoint.healthcheck", ["type", "path", "timeoutMs"]);
  if (value.type !== "http" && value.type !== "tcp") {
    throw new Error("previewManifest endpoint healthcheck type is invalid");
  }
  return {
    type: value.type,
    path:
      value.type === "http"
        ? pathValue(value.path, "endpoint.healthcheck.path")
        : undefined,
    timeoutMs: timeoutValue(value.timeoutMs, "endpoint.healthcheck.timeoutMs"),
  };
}

function parseBindings(value: unknown): PreviewManifestBinding[] | undefined {
  if (value === undefined) return undefined;
  limitedArray(value, "bindings", 50);
  return value.map(parseBinding);
}

function parseBinding(value: unknown): PreviewManifestBinding {
  if (!isRecord(value))
    throw new Error("previewManifest binding must be an object");
  assertOnlyKeys(value, "binding", [
    "target",
    "source",
    "exposure",
    "format",
    "path",
  ]);
  const exposure = requiredString(value.exposure, "binding.exposure");
  const format = optionalString(value.format) ?? "url";
  if (!bindingExposures.has(exposure))
    throw new Error("previewManifest binding exposure is invalid");
  if (!bindingFormats.has(format))
    throw new Error("previewManifest binding format is invalid");
  return {
    target: parseBindingTarget(value.target),
    source: parseBindingSource(value.source),
    exposure: exposure as PreviewManifestBinding["exposure"],
    format: format as PreviewManifestBinding["format"],
    path:
      value.path === undefined
        ? undefined
        : pathValue(value.path, "binding.path"),
  };
}

function parseBindingTarget(value: unknown) {
  if (!isRecord(value) || value.type !== "environment") {
    throw new Error(
      "previewManifest binding target must be an environment variable",
    );
  }
  assertOnlyKeys(value, "binding.target", ["type", "key"]);
  const key = requiredString(value.key, "binding.target.key");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error("previewManifest binding environment key is invalid");
  }
  return { type: "environment" as const, key };
}

function parseBindingSource(value: unknown) {
  if (!isRecord(value))
    throw new Error("previewManifest binding source must be an object");
  assertOnlyKeys(value, "binding.source", ["service", "endpoint"]);
  return {
    service: requiredString(value.service, "binding.source.service"),
    endpoint: requiredString(value.endpoint, "binding.source.endpoint"),
  };
}

function parseProbes(value: unknown): PreviewManifestProbe[] {
  limitedArray(value, "probes", 50);
  return value.map(parseProbe);
}

function parseProbe(value: unknown): PreviewManifestProbe {
  if (!isRecord(value))
    throw new Error("previewManifest probe must be an object");
  assertOnlyKeys(value, "probe", [
    "id",
    "from",
    "target",
    "type",
    "acceptedStatuses",
    "timeoutMs",
    "required",
  ]);
  if (value.type !== "http" && value.type !== "tcp") {
    throw new Error("previewManifest probe type is invalid");
  }
  return {
    id: requiredString(value.id, "probe.id"),
    from: requiredString(value.from, "probe.from"),
    target: parseProbeTarget(value.target),
    type: value.type,
    acceptedStatuses: parseStatuses(value.acceptedStatuses),
    timeoutMs:
      value.timeoutMs === undefined
        ? 10_000
        : timeoutValue(value.timeoutMs, "probe.timeoutMs"),
    required:
      value.required === undefined
        ? true
        : booleanValue(value.required, "probe.required"),
  };
}

function parseProbeTarget(value: unknown) {
  if (!isRecord(value))
    throw new Error("previewManifest probe target must be an object");
  assertOnlyKeys(value, "probe.target", ["service", "endpoint", "path"]);
  return {
    service: requiredString(value.service, "probe.target.service"),
    endpoint: requiredString(value.endpoint, "probe.target.endpoint"),
    path:
      value.path === undefined
        ? undefined
        : pathValue(value.path, "probe.target.path"),
  };
}

function parseStatuses(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error("previewManifest probe acceptedStatuses is invalid");
  }
  const statuses = value.map((status) =>
    numberValue(status, "probe.acceptedStatuses"),
  );
  if (statuses.some((status) => status < 100 || status >= 500)) {
    throw new Error("previewManifest probe acceptedStatuses is invalid");
  }
  return Array.from(new Set(statuses));
}

function parseCaches(value: unknown) {
  if (value === undefined) return [];
  limitedArray(value, "caches", 50);
  return value.map(parseCache);
}

function parseCache(value: unknown): PreviewManifestCache {
  if (!isRecord(value))
    throw new Error("previewManifest cache must be an object");
  assertOnlyKeys(value, "cache", ["name", "target"]);
  return {
    name: requiredString(value.name, "cache.name"),
    target: requiredString(value.target, "cache.target"),
  };
}

function parseRisks(value: unknown) {
  if (value === undefined) return [];
  limitedArray(value, "risks", 100);
  return value.map(parseRisk);
}

function parseRisk(value: unknown): PreviewManifestRisk {
  if (!isRecord(value))
    throw new Error("previewManifest risk must be an object");
  assertOnlyKeys(value, "risk", ["level", "message"]);
  if (typeof value.level !== "string" || !riskLevels.has(value.level)) {
    throw new Error("previewManifest risk level is invalid");
  }
  return {
    level: value.level as PreviewManifestRisk["level"],
    message: requiredString(value.message, "risk.message"),
  };
}

function validateTopology(manifest: PreviewManifest) {
  const services = new Map(
    manifest.services.map((service) => [service.id, service]),
  );
  for (const service of manifest.services)
    validateServiceTopology(service, services);
  for (const probe of manifest.probes) validateProbe(probe, services);
  validateDependencyCycles(manifest);
}

function validateServiceTopology(
  service: PreviewManifestService,
  services: Map<string, PreviewManifestService>,
) {
  uniqueIds(
    `endpoint in service ${service.id}`,
    service.endpoints.map(({ id }) => id),
  );
  uniqueIds(
    `binding in service ${service.id}`,
    (service.bindings ?? []).map(({ target }) => target.key),
  );
  for (const endpoint of service.endpoints) validateEndpoint(endpoint);
  for (const binding of service.bindings ?? [])
    validateBinding(binding, service, services);
}

function validateEndpoint(endpoint: PreviewManifestEndpoint) {
  validateId(endpoint.id, "endpoint");
  const healthcheck = endpoint.healthcheck;
  if (healthcheck?.type === "http" && endpoint.protocol === "tcp") {
    throw new Error(
      `previewManifest endpoint ${endpoint.id} cannot use an HTTP healthcheck`,
    );
  }
}

function validateBinding(
  binding: PreviewManifestBinding,
  consumer: PreviewManifestService,
  services: Map<string, PreviewManifestService>,
) {
  const source = services.get(binding.source.service);
  if (!source)
    throw new Error(
      `previewManifest binding references unknown service ${binding.source.service}`,
    );
  const endpoint = serviceEndpoint(source, binding.source.endpoint);
  if (!endpoint)
    throw new Error(
      `previewManifest binding references unknown endpoint ${binding.source.endpoint}`,
    );
  if (binding.format === "url" && endpoint.protocol === "tcp") {
    throw new Error(
      `previewManifest URL binding ${consumer.id}.${binding.target.key} targets TCP endpoint ${source.id}.${endpoint.id}. URL bindings require an HTTP endpoint. For TCP use format host, port or host-port. For a database connection URI, remove this binding, put the complete database URI in the consumer environment and add ${source.id} to dependsOn.`,
    );
  }
  if (consumer.id === source.id && binding.exposure === "server") {
    throw new Error(
      "previewManifest server binding cannot target the same service",
    );
  }
}

function validateProbe(
  probe: PreviewManifestProbe,
  services: Map<string, PreviewManifestService>,
) {
  validateId(probe.id, "probe");
  if (probe.from !== "host" && !services.has(probe.from)) {
    throw new Error(
      `previewManifest probe references unknown consumer ${probe.from}`,
    );
  }
  const target = services.get(probe.target.service);
  const endpoint = target && serviceEndpoint(target, probe.target.endpoint);
  if (!target || !endpoint)
    throw new Error("previewManifest probe target is unknown");
  if (probe.type === "http" && endpoint.protocol === "tcp") {
    throw new Error("previewManifest HTTP probe requires an HTTP endpoint");
  }
}

function serviceEndpoint(service: PreviewManifestService, id: string) {
  return service.endpoints.find((endpoint) => endpoint.id === id);
}

function validateDependencyCycles(manifest: PreviewManifest) {
  const graph = new Map<string, string[]>([
    ...manifest.setup.map((task) => [task.id, task.dependsOn ?? []] as const),
    ...manifest.services.map(
      (service) => [service.id, serviceDependencyIds(service)] as const,
    ),
  ]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  for (const id of graph.keys()) visitDependency(id, graph, visiting, visited);
}

function serviceDependencyIds(service: PreviewManifestService) {
  return Array.from(
    new Set([
      ...(service.dependsOn ?? []),
      ...(service.bindings ?? [])
        .filter(({ exposure }) => exposure === "server")
        .map(({ source }) => source.service),
    ]),
  );
}

function visitDependency(
  id: string,
  graph: Map<string, string[]>,
  visiting: Set<string>,
  visited: Set<string>,
) {
  if (visited.has(id)) return;
  if (visiting.has(id))
    throw new Error(
      "previewManifest service dependencies must not contain cycles",
    );
  visiting.add(id);
  for (const dependency of graph.get(id) ?? []) {
    if (graph.has(dependency))
      visitDependency(dependency, graph, visiting, visited);
  }
  visiting.delete(id);
  visited.add(id);
}

function validateSetupTask(
  task: PreviewManifestSetupTask,
  knownIds: Set<string>,
) {
  validateId(task.id, "setup task");
  validateContainer(task.container, `setup task ${task.id}`);
  validateWorkingDir(task.workingDir, `setup task ${task.id}`);
  validateCommand(task.command, `setup task ${task.id}`);
  validateEntrypoint(task.entrypoint, `setup task ${task.id}`);
  validateSetupRunAs(task);
  validateDependencies(task.dependsOn, knownIds, `setup task ${task.id}`);
}

function validateService(
  service: PreviewManifestService,
  knownIds: Set<string>,
) {
  validateId(service.id, "service");
  validateContainer(service.container, `service ${service.id}`);
  validateWorkingDir(service.workingDir, `service ${service.id}`);
  validateEntrypoint(service.entrypoint, `service ${service.id}`);
  validateContainerUser(service.user, `service ${service.id}`);
  if (service.kind !== "dependency" && !service.command) {
    throw new Error(
      `previewManifest service ${service.id} command is required`,
    );
  }
  if (service.command)
    validateCommand(service.command, `service ${service.id}`);
  validatePreviewService(service);
  validateDependencies(service.dependsOn, knownIds, `service ${service.id}`);
}

function validatePreviewService(service: PreviewManifestService) {
  if (
    service.surface?.type === "terminal" ||
    service.surface?.type === "display"
  )
    return;
  if (service.kind === "preview") {
    const published = service.endpoints.filter(
      ({ protocol }) => protocol !== "tcp",
    );
    if (!published.length) {
      throw new Error(
        `previewManifest service ${service.id} must define an HTTP endpoint`,
      );
    }
    if (!published.some(({ healthcheck }) => healthcheck)) {
      throw new Error(
        `previewManifest service ${service.id} healthcheck is required`,
      );
    }
  }
}

function validateContainer(
  container: PreviewManifestContainer,
  context: string,
) {
  if (container.image) validateImage(container.image, context);
  if (!container.build) return;
  validateWorkspacePath(container.build.context, `${context} build context`);
  validateWorkspacePath(container.build.dockerfile, `${context} Dockerfile`);
}

function validateCache(cache: PreviewManifestCache) {
  validateId(cache.name, "cache");
  if (!cache.target.startsWith("/"))
    throw new Error("previewManifest cache target must be absolute");
  if (unsafeCacheTarget(cache.target)) {
    throw new Error("previewManifest cache target is unsafe");
  }
}

function unsafeCacheTarget(target: string) {
  return (
    [
      "/",
      "/root",
      "/home",
      "/workspace",
      "/workspace/.git",
      "/var/run/docker.sock",
      "/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem",
    ].includes(target.replace(/\/$/, "")) ||
    target.startsWith("/workspace/.git/") ||
    target.includes("..") ||
    target.startsWith("/home/") ||
    target.includes("docker.sock")
  );
}

function validateCommand(command: string, context: string) {
  if (command.length > 4_000)
    throw new Error(`previewManifest ${context} command is too long`);
  if (
    unsafeCommandPatterns.some((pattern) => pattern.test(command)) ||
    unsafeWorkspaceOwnershipCommand(command)
  ) {
    throw new Error(`previewManifest ${context} command is unsafe`);
  }
}

function validateSetupRunAs(task: PreviewManifestSetupTask) {
  if (task.runAs !== "root") return;
  if (!workspacePermissionRepairCommand(task.command)) {
    throw new Error(`previewManifest setup task ${task.id} cannot run as root`);
  }
}

function workspacePermissionRepairCommand(command: string) {
  return (
    command.includes("/workspace") &&
    !unsafeWorkspaceOwnershipCommand(command) &&
    /\b(?:chown|chmod|rm\s+-rf)\b/.test(command) &&
    /\/workspace\/\.(?:nuxt|next|vite)\b|\/workspace\/node_modules\b/.test(
      command,
    )
  );
}

function unsafeWorkspaceOwnershipCommand(command: string) {
  return (
    /\b(?:chown|chmod)\b/.test(command) &&
    /\/workspace(?:\s|$)|\/workspace\/(?:apps|packages)(?:\s|\/|$)/.test(
      command,
    )
  );
}

function validateImage(image: string, context: string) {
  if (/\$|\n|\r|:\/\/|@[^/]+@/.test(image) || image.includes(".."))
    throw new Error(`previewManifest ${context} image must be literal`);
}

function validateEntrypoint(value: string[] | undefined, context: string) {
  if (value?.some((entry) => /[\0\r\n]/.test(entry))) {
    throw new Error(`previewManifest ${context} entrypoint is invalid`);
  }
}

function validateContainerUser(value: string | undefined, context: string) {
  if (!value) return;
  if (
    !/^[a-zA-Z_][a-zA-Z0-9_.-]*$|^[1-9][0-9]*(?::[1-9][0-9]*)?$/.test(value)
  ) {
    throw new Error(`previewManifest ${context} user must be non-root`);
  }
}

function validateWorkingDir(value: string | undefined, context: string) {
  if (value && (!value.startsWith("/") || value.includes(".."))) {
    throw new Error(`previewManifest ${context} workingDir is invalid`);
  }
}

function validateDependencies(
  ids: string[] | undefined,
  knownIds: Set<string>,
  context: string,
) {
  for (const id of ids ?? []) {
    if (!knownIds.has(id))
      throw new Error(
        `previewManifest ${context} depends on unknown service ${id}`,
      );
  }
}

function uniqueIds(context: string, ids: string[]) {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`previewManifest ${context} ids must be unique`);
  }
}

function validateId(value: string, field: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value)) {
    throw new Error(`previewManifest ${field} id is invalid`);
  }
}

function serviceKind(value: unknown): PreviewManifestServiceKind {
  if (
    typeof value !== "string" ||
    !serviceKinds.has(value as PreviewManifestServiceKind)
  ) {
    throw new Error("previewManifest service kind is invalid");
  }
  return value as PreviewManifestServiceKind;
}

function portValue(value: unknown, field: string) {
  const port = numberValue(value, field);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`previewManifest ${field} is invalid`);
  }
  return port;
}

function timeoutValue(value: unknown, field: string) {
  const timeout = numberValue(value, field);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    throw new Error(`previewManifest ${field} is invalid`);
  }
  return timeout;
}

function numberValue(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`previewManifest ${field} is invalid`);
  }
  return value;
}

function pathValue(value: unknown, field: string) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    /[\r\n]/.test(value)
  ) {
    throw new Error(`previewManifest ${field} is invalid`);
  }
  return value;
}

function parseEnvironment(
  value: unknown,
  field: string,
): PreviewManifestEnvironment | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value))
    throw new Error(`previewManifest ${field} must be an object`);
  if (Object.keys(value).length > 200) {
    throw new Error(`previewManifest ${field} has too many entries`);
  }
  const environment: PreviewManifestEnvironment = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      typeof entry !== "string" ||
      entry.length > 8_192
    ) {
      throw new Error(`previewManifest ${field} is invalid`);
    }
    const rejection = previewEnvironmentValueRejection(entry);
    if (rejection) {
      throw new Error(
        `previewManifest ${field}.${key} ${rejection}; keep real credentials out of the preview manifest`,
      );
    }
    environment[key] = entry;
  }
  return environment;
}

function parseRunAs(value: unknown) {
  if (value === undefined) return undefined;
  if (value !== "host" && value !== "root") {
    throw new Error("previewManifest setup.runAs is invalid");
  }
  return value;
}

function parseOptionalStrings(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`previewManifest ${field} must be a string array`);
  }
  return value as string[];
}

function parseOptionalCommand(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 100 ||
    value.some(
      (entry) => typeof entry !== "string" || !entry || entry.length > 4_000,
    )
  ) {
    throw new Error(`previewManifest ${field} must be a bounded string array`);
  }
  return value as string[];
}

function workspaceRelativePath(value: unknown, field: string) {
  const path = requiredString(value, field);
  validateWorkspacePath(path, field);
  return path;
}

function validateWorkspacePath(path: string, field: string) {
  const parts = path.replace(/\\/g, "/").split("/");
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-zA-Z]:/.test(path) ||
    parts.includes("..") ||
    parts.includes("") ||
    /[\0\r\n]/.test(path)
  ) {
    throw new Error(`previewManifest ${field} must stay inside the workspace`);
  }
}

function safeBuildTarget(value: unknown, field: string) {
  const target = requiredString(value, field);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(target)) {
    throw new Error(`previewManifest ${field} is invalid`);
  }
  return target;
}

function limitedArray(
  value: unknown,
  field: string,
  maximumLength: number,
): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new Error(`previewManifest ${field} must be a bounded array`);
  }
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`previewManifest ${field} is required`);
  }
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanValue(value: unknown, field: string) {
  if (typeof value !== "boolean")
    throw new Error(`previewManifest ${field} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  context: string,
  allowed: readonly string[],
) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new Error(
      `previewManifest ${context} contains unsupported field ${unknown[0]}`,
    );
  }
}
