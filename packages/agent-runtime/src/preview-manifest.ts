import {
  parsePreviewManifest as parseContractPreviewManifest,
  validatePreviewManifest as validateContractPreviewManifest,
} from "@blame/preview-contract";
import type {
  PreviewManifest,
  PreviewManifestBinding,
  PreviewManifestCache,
  PreviewManifestEndpoint,
  PreviewManifestEnvironment,
  PreviewManifestProject,
  PreviewManifestService,
  PreviewManifestSetupTask,
} from "@blame/preview-contract";
import type { ProjectInitializationPreferences } from "./types.js";
import { commandWithNextWebpackFallback } from "./next-webpack-fallback.js";
import {
  containerImage,
  defaultSetupRunAs,
  mysqlImage,
  previewEndpoint,
  runsNodePackageManager,
  serviceEndpoint,
  uniqueStrings,
} from "./preview-manifest-helpers.js";

export function parsePreviewManifest(value: unknown): PreviewManifest {
  return normalizePreviewManifest(
    parseContractPreviewManifest(
      normalizeServiceRoleReferences(normalizeRootServiceBindings(value)),
    ),
  );
}

function normalizeRootServiceBindings(value: unknown) {
  if (
    !isRecord(value) ||
    !Array.isArray(value.services) ||
    !Array.isArray(value.bindings)
  ) {
    return value;
  }
  const consumers = value.services.filter(
    (service) => isRecord(service) && service.kind !== "dependency",
  );
  if (consumers.length !== 1) return value;
  const consumer = consumers[0]!;
  const bindings = Array.isArray(consumer.bindings)
    ? [...consumer.bindings, ...value.bindings]
    : value.bindings;
  const manifest = { ...value };
  delete manifest.bindings;
  return {
    ...manifest,
    services: value.services.map((service) =>
      service === consumer ? { ...consumer, bindings } : service,
    ),
  };
}

function normalizeServiceRoleReferences(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.services)) return value;
  const roleIds = uniqueServiceRoleIds(value.services);
  if (!Array.isArray(value.probes) || roleIds.size === 0) return value;
  return {
    ...value,
    probes: value.probes.map((probe) => normalizedProbeFrom(probe, roleIds)),
  };
}

function uniqueServiceRoleIds(services: unknown[]) {
  const idsByRole = new Map<string, string[]>();
  for (const service of services) {
    if (!isRecord(service)) continue;
    const { id, kind } = service;
    if (typeof id !== "string" || typeof kind !== "string") continue;
    idsByRole.set(kind, [...(idsByRole.get(kind) ?? []), id]);
  }
  return new Map(
    [...idsByRole].flatMap(([role, ids]) =>
      ids.length === 1 ? [[role, ids[0]!] as const] : [],
    ),
  );
}

function normalizedProbeFrom(probe: unknown, roleIds: Map<string, string>) {
  if (!isRecord(probe) || typeof probe.from !== "string") return probe;
  const serviceId = roleIds.get(probe.from);
  return serviceId ? { ...probe, from: serviceId } : probe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validatePreviewManifest(manifest: PreviewManifest) {
  validateContractPreviewManifest(manifest);
}

export function normalizePreviewManifest(
  manifest: PreviewManifest,
): PreviewManifest {
  return normalizePreviewManifestWithPreferences(manifest);
}

export function normalizePreviewManifestWithPreferences(
  manifest: PreviewManifest,
  preferences?: ProjectInitializationPreferences,
): PreviewManifest {
  const caches = normalizedCaches(manifest);
  const services = manifest.services.map((service) =>
    normalizeService(service, caches),
  );
  const normalizedServices = services.map((service) =>
    normalizeServiceBindings(
      service,
      services,
      isNuxtProject(manifest.project),
    ),
  );
  const normalized = {
    ...manifest,
    project: {
      root: manifest.project.root || ".",
      detectedStack: manifest.project.detectedStack ?? [],
      confidence: manifest.project.confidence ?? manifest.confidence,
    },
    setup: manifest.setup.map((task) => {
      const environment = normalizedEnvironment(
        normalizedAppEnvironment({
          ...inheritedSetupTaskDatabaseEnvironment(task, normalizedServices),
          ...(task.environment ?? {}),
        }),
        caches,
      );
      return {
        ...task,
        workingDir: task.workingDir || "/workspace",
        command: commandWithLocalCorepackShims(task.command),
        runAs: task.runAs ?? defaultSetupRunAs(task.command),
        environment,
        dependsOn: uniqueStrings([
          ...(task.dependsOn ?? []),
          ...referencedDependencyServices(
            task.command,
            environment,
            normalizedServices,
          ),
        ]),
      };
    }),
    services: normalizedServices,
    caches,
    risks: manifest.risks,
  };
  return applyPreviewManifestPreferences(
    previewManifestWithNextWebpackFallback(normalized),
    preferences,
  );
}

// A setup task that reaches a dependency service by host name, such as a
// migration whose DATABASE_URL points at `postgres:5432`, needs that service
// running first, whether or not the manifest declared it.
function referencedDependencyServices(
  command: string,
  environment: PreviewManifestEnvironment | undefined,
  services: PreviewManifestService[],
) {
  const text = [command, ...Object.values(environment ?? {})].join("\n");
  return services
    .filter(({ kind }) => kind === "dependency")
    .map(({ id }) => id)
    .filter((id) =>
      new RegExp(
        `(?:^|[\\s/@=])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?::\\d+|/|\\s|$)`,
        "m",
      ).test(text),
    );
}

function normalizeServiceBindings(
  service: PreviewManifestService,
  services: PreviewManifestService[],
  inferNuxtServerBindings: boolean,
) {
  const bindings = normalizedServiceBindings(
    service.bindings ?? [],
    inferNuxtServerBindings,
  );
  const serverDependencies = new Set(
    serverBindingDependencies(service, bindings),
  );
  const browserOnlyDependencies = new Set(
    bindings
      .filter(
        (binding) =>
          binding.exposure === "browser" &&
          !serverDependencies.has(binding.source.service),
      )
      .map((binding) => binding.source.service),
  );
  const environment = { ...service.environment };
  for (const binding of bindings) {
    environment[binding.target.key] = compiledBindingValue(binding, services);
  }
  return {
    ...service,
    bindings,
    environment,
    dependsOn: uniqueStrings([
      ...(service.dependsOn ?? []).filter(
        (dependency) => !browserOnlyDependencies.has(dependency),
      ),
      ...serverDependencies,
    ]),
  };
}

function normalizedServiceBindings(
  bindings: PreviewManifestBinding[],
  inferNuxtServerBindings: boolean,
) {
  if (!inferNuxtServerBindings) return bindings;
  const targetKeys = new Set(bindings.map(({ target }) => target.key));
  const inferred = bindings.flatMap((binding) => {
    const match = /^NUXT_PUBLIC_(.+)$/.exec(binding.target.key);
    if (binding.exposure !== "browser" || !match?.[1]) return [];
    const key = `NUXT_${match[1]}`;
    if (targetKeys.has(key)) return [];
    targetKeys.add(key);
    return [
      {
        ...binding,
        target: { ...binding.target, key },
        exposure: "server" as const,
      },
    ];
  });
  return [...bindings, ...inferred];
}

function serverBindingDependencies(
  service: PreviewManifestService,
  bindings: PreviewManifestBinding[],
) {
  return bindings
    .filter((binding) => binding.exposure === "server")
    .map((binding) => binding.source.service)
    .filter((sourceId) => sourceId !== service.id);
}

function compiledBindingValue(
  binding: PreviewManifestBinding,
  services: PreviewManifestService[],
) {
  const source = services.find(({ id }) => id === binding.source.service);
  const endpoint = source && serviceEndpoint(source, binding.source.endpoint);
  if (!source || !endpoint)
    throw new Error("previewManifest binding source is unknown");
  if (binding.exposure === "browser")
    return browserBindingValue(binding, endpoint);
  return serverBindingValue(binding, source.id, endpoint);
}

function browserBindingValue(
  binding: PreviewManifestBinding,
  endpoint: PreviewManifestEndpoint,
) {
  const port = `__BLAME_PREVIEW_PORT_${binding.source.service}_${endpoint.port}__`;
  const path = binding.path ?? "";
  if (binding.format === "host") return "localhost";
  if (binding.format === "port") return port;
  if (binding.format === "host-port") return `localhost:${port}`;
  return `${endpoint.protocol}://localhost:${port}${path}`;
}

function serverBindingValue(
  binding: PreviewManifestBinding,
  host: string,
  endpoint: PreviewManifestEndpoint,
) {
  if (binding.format === "host") return host;
  if (binding.format === "port") return String(endpoint.port);
  if (binding.format === "host-port") return `${host}:${endpoint.port}`;
  return `${endpoint.protocol}://${host}:${endpoint.port}${binding.path ?? ""}`;
}

function previewManifestWithNextWebpackFallback(manifest: PreviewManifest) {
  if (!isNextProject(manifest.project)) return manifest;
  return {
    ...manifest,
    services: manifest.services.map((service) => ({
      ...service,
      command:
        service.kind === "preview" && service.command
          ? commandWithNextWebpackFallback(service.command)
          : service.command,
    })),
  };
}

function isNextProject(project: PreviewManifestProject) {
  return (project.detectedStack ?? []).some((stack) =>
    ["next", "nextjs", "next.js"].includes(stack.toLowerCase()),
  );
}

function isNuxtProject(project: PreviewManifestProject) {
  return (project.detectedStack ?? []).some((stack) =>
    ["nuxt", "nuxtjs", "nuxt.js"].includes(stack.toLowerCase()),
  );
}

function applyPreviewManifestPreferences(
  manifest: PreviewManifest,
  preferences: ProjectInitializationPreferences | undefined,
) {
  if (preferences?.database?.mode !== "existing") return manifest;
  return manifestWithoutComposeDatabase(manifest);
}

function manifestWithoutComposeDatabase(manifest: PreviewManifest) {
  const databaseServiceIds = new Set(
    manifest.services.filter(databaseService).map((service) => service.id),
  );
  const setup = manifest.setup
    .filter((task) => !setupTaskTouchesDatabase(task))
    .map((task) => ({
      ...task,
      environment: withoutDatabaseEnvironment(task.environment),
      dependsOn: withoutIds(task.dependsOn, databaseServiceIds),
    }));
  const removedSetupIds = new Set(
    manifest.setup
      .filter((task) => !setup.some((candidate) => candidate.id === task.id))
      .map((task) => task.id),
  );
  return {
    ...manifest,
    setup,
    services: manifest.services
      .filter((service) => !databaseServiceIds.has(service.id))
      .map((service) =>
        withoutComposeDatabaseBindings(
          service,
          new Set([...databaseServiceIds, ...removedSetupIds]),
        ),
      ),
    probes: (manifest.probes ?? []).filter(
      (probe) =>
        !databaseServiceIds.has(probe.target.service) &&
        !databaseServiceIds.has(probe.from),
    ),
  };
}

function withoutComposeDatabaseBindings(
  service: PreviewManifestService,
  blockedIds: Set<string>,
) {
  const removedBindings = (service.bindings ?? []).filter((binding) =>
    blockedIds.has(binding.source.service),
  );
  const environment = withoutDatabaseEnvironment(service.environment) ?? {};
  for (const binding of removedBindings) delete environment[binding.target.key];
  return {
    ...service,
    environment,
    bindings: (service.bindings ?? []).filter(
      (binding) => !blockedIds.has(binding.source.service),
    ),
    dependsOn: withoutIds(service.dependsOn, blockedIds),
  };
}

function databaseService(service: PreviewManifestService) {
  return (
    service.kind === "dependency" &&
    databaseImage(containerImage(service.container))
  );
}

function databaseImage(image: string) {
  return [
    /^mysql(?::|$)/,
    /\/mysql(?::|$)/,
    /^mariadb(?::|$)/,
    /\/mariadb(?::|$)/,
    /^postgres(?::|$)/,
    /\/postgres(?::|$)/,
    /^mongo(?::|$)/,
    /\/mongo(?::|$)/,
  ].some((pattern) => pattern.test(image));
}

function setupTaskTouchesDatabase(task: PreviewManifestSetupTask) {
  return /\bmigrat(?:e|ion|ions)\b/i.test(task.command);
}

function inheritedSetupTaskDatabaseEnvironment(
  task: PreviewManifestSetupTask,
  services: PreviewManifestService[],
) {
  if (!setupTaskTouchesDatabase(task)) return {};
  const workingDir = task.workingDir || "/workspace";
  const dependencyIds = new Set(task.dependsOn ?? []);
  const candidates = services
    .filter(
      (service) =>
        service.workingDir === workingDir &&
        Object.keys(service.environment ?? {}).some(databaseEnvironmentKey),
    )
    .sort(
      (left, right) =>
        sharedDependencyCount(right, dependencyIds) -
        sharedDependencyCount(left, dependencyIds),
    );
  return Object.fromEntries(
    Object.entries(candidates[0]?.environment ?? {}).filter(([key]) =>
      databaseEnvironmentKey(key),
    ),
  );
}

function sharedDependencyCount(
  service: PreviewManifestService,
  dependencyIds: Set<string>,
) {
  return (service.dependsOn ?? []).filter((id) => dependencyIds.has(id)).length;
}

function withoutDatabaseEnvironment(
  environment: PreviewManifestEnvironment | undefined,
) {
  if (!environment) return undefined;
  const next: PreviewManifestEnvironment = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!databaseEnvironmentKey(key)) next[key] = value;
  }
  return next;
}

function databaseEnvironmentKey(key: string) {
  return (
    key === "DATABASE_URL" ||
    key === "MONGO_URL" ||
    key === "MONGODB_URI" ||
    key.startsWith("DB_") ||
    key.startsWith("MYSQL_") ||
    key.startsWith("POSTGRES_") ||
    key.startsWith("PG")
  );
}

function withoutIds(ids: string[] | undefined, blockedIds: Set<string>) {
  return uniqueStrings((ids ?? []).filter((id) => !blockedIds.has(id)));
}

function normalizeService(
  service: PreviewManifestService,
  caches: PreviewManifestCache[],
): PreviewManifestService {
  const endpoint = previewEndpoint(service);
  const previewEnvironment: PreviewManifestEnvironment = endpoint
    ? {
        HOST: "0.0.0.0",
        PORT: String(endpoint.port),
      }
    : {};
  return {
    ...service,
    workingDir: service.workingDir || "/workspace",
    command: service.command
      ? commandWithLocalCorepackShims(service.command)
      : undefined,
    environment: normalizedEnvironment(
      {
        ...normalizedServiceEnvironment(service),
        ...previewEnvironment,
      },
      caches,
    ),
    dependsOn: uniqueStrings(service.dependsOn ?? []),
  };
}

function commandWithLocalCorepackShims(command: string) {
  const composeSafeCommand = escapeCorepackHomeForCompose(
    normalizePnpmScriptOptionSeparator(command),
  );
  if (
    !/\bcorepack\s+(?:pnpm|yarn)\b/.test(composeSafeCommand) ||
    composeSafeCommand.includes(
      'corepack enable --install-directory "$$COREPACK_HOME/bin"',
    )
  ) {
    return composeSafeCommand;
  }
  return [
    'mkdir -p "$$COREPACK_HOME/bin"',
    'corepack enable --install-directory "$$COREPACK_HOME/bin"',
    'export PATH="$$COREPACK_HOME/bin:$$PATH"',
    composeSafeCommand,
  ].join(" && ");
}

function normalizePnpmScriptOptionSeparator(command: string) {
  return command.replace(
    /(\b(?:corepack\s+)?pnpm\b(?:(?!&&|\|\||;).)*?\b(?:dev|start|preview|serve))\s+--\s+(?=--(?:host(?:name)?|port)\b)/g,
    "$1 ",
  );
}

function escapeCorepackHomeForCompose(command: string) {
  return command.replace(
    /(?<!\$)\$(?:COREPACK_HOME\b|\{COREPACK_HOME\})/g,
    (match) => `$${match}`,
  );
}

function normalizedServiceEnvironment(service: PreviewManifestService) {
  const environment = service.environment ?? {};
  if (
    service.kind !== "dependency" ||
    !mysqlImage(containerImage(service.container))
  ) {
    return normalizedAppEnvironment(environment);
  }
  return normalizedMysqlEnvironment(normalizedAppEnvironment(environment));
}

function normalizedMysqlEnvironment(environment: PreviewManifestEnvironment) {
  if (environment.MYSQL_USER !== "root") return environment;
  const { MYSQL_PASSWORD: password, ...rest } = environment;
  delete rest.MYSQL_USER;
  return {
    ...rest,
    MYSQL_ROOT_PASSWORD: rest.MYSQL_ROOT_PASSWORD ?? password ?? "root",
  };
}

function normalizedAppEnvironment(environment: PreviewManifestEnvironment) {
  const normalized: PreviewManifestEnvironment = {};
  for (const [key, value] of Object.entries(environment)) {
    if (key === "APP_KEY" && value.length < 16) continue;
    if (placeholderEnvironmentValue(value)) continue;
    normalized[key] = value;
  }
  return normalized;
}

function placeholderEnvironmentValue(value: string) {
  const normalized = value.trim().toLowerCase();
  return (
    [
      "preview",
      "placeholder",
      "preview-app-key",
      "blame-dev-app-key",
      "changeme",
      "change-me",
      "replace-me",
    ].includes(normalized) || normalized.startsWith("your_")
  );
}

function normalizedCaches(manifest: PreviewManifest) {
  const cacheByName = new Map<string, PreviewManifestCache>();
  for (const cache of manifest.caches) cacheByName.set(cache.name, cache);
  const commands = [
    ...manifest.setup.map((task) => task.command),
    ...manifest.services.map((service) => service.command ?? ""),
  ].join("\n");
  if (runsNodePackageManager(commands)) {
    cacheByName.set("blame_node_modules", {
      name: "blame_node_modules",
      target: "/workspace/node_modules",
    });
  }
  if (/\bcorepack\s+prepare\b/.test(commands)) {
    cacheByName.set("blame_corepack_cache", {
      name: "blame_corepack_cache",
      target: "/tmp/corepack-cache",
    });
  }
  if (/\b(?:corepack\s+)?pnpm\s+(?:install|ci|exec|run)\b/.test(commands)) {
    cacheByName.set("blame_pnpm_store", {
      name: "blame_pnpm_store",
      target: "/pnpm/store",
    });
  }
  if (/\bnpm\s+(?:install|run|exec)\b/.test(commands)) {
    cacheByName.set("blame_npm_cache", {
      name: "blame_npm_cache",
      target: "/npm/cache",
    });
  }
  if (/\b(?:corepack\s+)?yarn\s+(?:install|run|exec)\b/.test(commands)) {
    cacheByName.set("blame_yarn_cache", {
      name: "blame_yarn_cache",
      target: "/cache/yarn",
    });
  }
  if (/\bbun\s+(?:install|run|x)\b/.test(commands)) {
    cacheByName.set("blame_bun_cache", {
      name: "blame_bun_cache",
      target: "/cache/bun",
    });
  }
  if (/\b(?:python\s+-m\s+)?pip3?\s+install\b/.test(commands)) {
    cacheByName.set("blame_pip_cache", {
      name: "blame_pip_cache",
      target: "/cache/pip",
    });
  }
  if (/\bcargo\s+(?:fetch|build|run|test)\b/.test(commands)) {
    cacheByName.set("blame_cargo_cache", {
      name: "blame_cargo_cache",
      target: "/cache/cargo",
    });
  }
  return Array.from(cacheByName.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function normalizedEnvironment(
  environment: PreviewManifestEnvironment,
  caches: PreviewManifestCache[],
) {
  return {
    ...environment,
    ...cacheEnvironment(caches),
  };
}

function cacheEnvironment(caches: PreviewManifestCache[]) {
  const byTarget = new Map(caches.map((cache) => [cache.target, cache.name]));
  return {
    ...(byTarget.has("/tmp/corepack-cache")
      ? { COREPACK_HOME: "/tmp/corepack-cache" }
      : {}),
    ...(byTarget.has("/pnpm/store")
      ? { npm_config_store_dir: "/pnpm/store" }
      : {}),
    ...(byTarget.has("/npm/cache") ? { NPM_CONFIG_CACHE: "/npm/cache" } : {}),
    ...(byTarget.has("/cache/yarn")
      ? { YARN_CACHE_FOLDER: "/cache/yarn" }
      : {}),
    ...(byTarget.has("/cache/bun")
      ? { BUN_INSTALL_CACHE_DIR: "/cache/bun" }
      : {}),
    ...(byTarget.has("/cache/pip") ? { PIP_CACHE_DIR: "/cache/pip" } : {}),
    ...(byTarget.has("/cache/cargo") ? { CARGO_HOME: "/cache/cargo" } : {}),
  };
}
