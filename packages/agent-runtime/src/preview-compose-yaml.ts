import type {
  PreviewManifest,
  PreviewManifestCache,
  PreviewManifestContainer,
  PreviewManifestEndpoint,
  PreviewManifestEnvironment,
  PreviewManifestService,
  PreviewManifestSetupTask,
} from "@blame/preview-contract";

export function serviceEndpoint(
  service: PreviewManifestService,
  endpointId: string,
): PreviewManifestEndpoint | undefined {
  return service.endpoints.find(({ id }) => id === endpointId);
}

export function previewEndpoint(service: PreviewManifestService) {
  return service.kind === "preview"
    ? service.endpoints.find(({ protocol }) => protocol !== "tcp")
    : undefined;
}

export function containerImage(container: PreviewManifestContainer) {
  return container.image ?? "";
}

export function setupScript() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `export COMPOSE_PROJECT_NAME="\${COMPOSE_PROJECT_NAME:-blame_$(pwd | cksum | awk '{print $1}')}"`,
    `export BLAME_PROJECT_ROOT="\${BLAME_PROJECT_ROOT:-$(pwd)}"`,
    `export BLAME_HOST_UID="\${BLAME_HOST_UID:-$(id -u 2>/dev/null || echo 1000)}"`,
    `export BLAME_HOST_GID="\${BLAME_HOST_GID:-$(id -g 2>/dev/null || echo 1000)}"`,
    "",
  ].join("\n");
}

export function composeYaml(manifest: PreviewManifest) {
  const runtimeServiceIds = new Set(
    manifest.services.map((service) => service.id),
  );
  const services = [
    ...volumeInitService(manifest.caches),
    ...manifest.setup.flatMap((task) => setupTaskYaml(task, manifest)),
    ...manifest.services.flatMap((service) =>
      serviceYaml(service, manifest, manifest.caches, runtimeServiceIds),
    ),
  ];
  const volumes = manifest.caches.flatMap((cache) => [`  ${cache.name}:`]);
  return [
    ...(services.length ? ["services:", ...services] : ["services: {}"]),
    ...(volumes.length ? ["volumes:", ...volumes] : ["volumes: {}"]),
  ].join("\n");
}

function volumeInitService(caches: PreviewManifestCache[]) {
  if (caches.length === 0) return [];
  const targets = caches.map((cache) => cache.target).join(" ");
  return [
    "  blame-volumes-init:",
    "    image: node:22-bookworm-slim",
    `    command: ${yamlString(`sh -lc "mkdir -p ${targets} && chown -R 0:0 ${targets}"`)}`,
    "    volumes:",
    ...caches.map(
      (cache) => `      - ${yamlString(`${cache.name}:${cache.target}`)}`,
    ),
  ];
}

function containerYaml(container: PreviewManifestContainer) {
  if (container.image) return [`    image: ${yamlString(container.image)}`];
  if (!container.build) {
    throw new Error("previewManifest container source is missing");
  }
  const context =
    container.build.context === "."
      ? "${BLAME_PROJECT_ROOT}"
      : `\${BLAME_PROJECT_ROOT}/${container.build.context}`;
  return [
    "    build:",
    `      context: ${yamlString(context)}`,
    `      dockerfile: ${yamlString(container.build.dockerfile)}`,
    ...(container.build.target
      ? [`      target: ${yamlString(container.build.target)}`]
      : []),
  ];
}

function entrypointYaml(entrypoint: string[] | undefined) {
  return entrypoint?.length
    ? [`    entrypoint: ${JSON.stringify(entrypoint)}`]
    : [];
}

function setupTaskYaml(
  task: PreviewManifestSetupTask,
  manifest: PreviewManifest,
) {
  const caches = manifest.caches;
  return [
    `  ${task.id}:`,
    ...containerYaml(task.container),
    ...entrypointYaml(task.entrypoint),
    `    working_dir: ${yamlString(task.workingDir ?? "/workspace")}`,
    `    command: ${yamlString(
      `sh -lc ${shellQuote(setupTaskCommand(task, manifest.services))}`,
    )}`,
    "    labels:",
    `      blame.setup: "true"`,
    ...environmentYaml(task.environment ?? {}),
    ...dependsOnYaml([
      ...(caches.length > 0
        ? [
            dependsOnEntry(
              "blame-volumes-init",
              "service_completed_successfully",
            ),
          ]
        : []),
      ...(task.dependsOn ?? []).map((id) =>
        dependsOnEntry(id, setupDependencyCondition(id, manifest)),
      ),
    ]),
    ...volumeYaml(caches, true),
  ];
}

function serviceYaml(
  service: PreviewManifestService,
  manifest: PreviewManifest,
  caches: PreviewManifestCache[],
  runtimeServiceIds: Set<string>,
) {
  return [
    `  ${service.id}:`,
    ...containerYaml(service.container),
    ...entrypointYaml(service.entrypoint),
    ...(service.user ? [`    user: ${yamlString(service.user)}`] : []),
    ...(service.kind === "dependency" && !service.command
      ? []
      : [`    working_dir: ${yamlString(service.workingDir ?? "/workspace")}`]),
    ...(service.command
      ? [
          `    command: ${yamlString(
            `sh -lc ${shellQuote(serviceCommand(service, manifest.services))}`,
          )}`,
        ]
      : []),
    ...environmentYaml(service.environment ?? {}),
    ...labelsYaml(service),
    ...portsYaml(service, manifest),
    ...serviceHealthcheckYaml(service),
    ...dependsOnYaml([
      ...(service.dependsOn ?? [])
        .filter((id) => runtimeServiceIds.has(id))
        .map((id) =>
          dependsOnEntry(id, serviceDependencyCondition(id, manifest.services)),
        ),
    ]),
    ...volumeYaml(caches, serviceNeedsWorkspace(service)),
  ];
}

function labelsYaml(service: PreviewManifestService) {
  const labels = [
    ["blame.service.id", service.id],
    ["blame.service.kind", service.kind],
    ...previewLabels(service),
    ...endpointLabels(service),
    ...bindingLabels(service),
  ];
  return [
    "    labels:",
    ...labels.map(([key, value]) => `      ${key}: ${yamlString(value)}`),
  ];
}

function previewLabels(service: PreviewManifestService) {
  const endpoint = previewEndpoint(service);
  if (!endpoint) return [];
  return [
    ["blame.preview", "true"],
    ["blame.preview.port", String(endpoint.port)],
    ["blame.preview.protocol", endpoint.protocol],
    ["blame.preview.path", endpoint.healthcheck?.path ?? "/"],
  ];
}

function endpointLabels(service: PreviewManifestService) {
  return (service.endpoints ?? []).flatMap((endpoint, index) => [
    [`blame.endpoint.${index}.id`, endpoint.id],
    [`blame.endpoint.${index}.protocol`, endpoint.protocol],
    [`blame.endpoint.${index}.port`, String(endpoint.port)],
  ]);
}

function bindingLabels(service: PreviewManifestService) {
  return (service.bindings ?? []).flatMap((binding, index) => [
    [`blame.binding.${index}.key`, binding.target.key],
    [`blame.binding.${index}.source.service`, binding.source.service],
    [`blame.binding.${index}.source.endpoint`, binding.source.endpoint],
    [`blame.binding.${index}.exposure`, binding.exposure],
    [`blame.binding.${index}.format`, binding.format ?? "url"],
  ]);
}

function serviceCommand(
  service: PreviewManifestService,
  services: PreviewManifestService[],
) {
  const waitCommands = dependencyWaitCommands(service, services);
  return [...waitCommands, service.command].filter(Boolean).join(" && ");
}

function serviceNeedsWorkspace(service: PreviewManifestService) {
  return (
    service.kind !== "dependency" ||
    (!!service.command &&
      (service.workingDir ?? "/workspace").startsWith("/workspace"))
  );
}

function dependencyWaitCommands(
  service: PreviewManifestService,
  services: PreviewManifestService[],
) {
  if (!nodeImage(containerImage(service.container))) return [];
  return (service.dependsOn ?? [])
    .map((id) => services.find((candidate) => candidate.id === id))
    .map((dependency) => dependencyWaitTarget(dependency))
    .filter((target): target is { host: string; port: number } => !!target)
    .map((target) => waitForTcpCommand(target.host, target.port));
}

function dependencyWaitTarget(service: PreviewManifestService | undefined) {
  if (!service) return undefined;
  const endpoint = (service.endpoints ?? [])[0];
  if (endpoint) return { host: service.id, port: endpoint.port };
  if (mysqlImage(containerImage(service.container))) {
    return { host: service.id, port: 3306 };
  }
  return undefined;
}

function waitForTcpCommand(host: string, port: number) {
  const script = [
    `const net=require("net")`,
    `const host=${JSON.stringify(host)}`,
    `const port=${port}`,
    `const deadline=Date.now()+60000`,
    `function retry(){const socket=net.connect(port,host,()=>process.exit(0));socket.setTimeout(1000,()=>socket.destroy());socket.once("error",next);socket.once("timeout",next)}`,
    `function next(){if(Date.now()>deadline)process.exit(1);setTimeout(retry,1000)}`,
    `retry()`,
  ].join(";");
  return `node -e ${shellQuote(script)}`;
}

function portsYaml(service: PreviewManifestService, manifest: PreviewManifest) {
  const ports = publishedServicePorts(service, manifest);
  if (ports.length === 0) return [];
  return [
    "    ports:",
    ...ports.map((port) => `      - ${yamlString(`127.0.0.1::${port}`)}`),
  ];
}

function publishedServicePorts(
  service: PreviewManifestService,
  manifest: PreviewManifest,
) {
  const endpointIds = [
    ...browserBindingEndpointIds(service.id, manifest.services),
    ...hostProbeEndpointIds(service.id, manifest),
  ];
  const endpointPorts = endpointIds.flatMap((endpointId) => {
    const endpoint = serviceEndpoint(service, endpointId);
    return endpoint ? [endpoint.port] : [];
  });
  return Array.from(
    new Set([
      ...(previewEndpoint(service) ? [previewEndpoint(service)!.port] : []),
      ...endpointPorts,
    ]),
  );
}

function browserBindingEndpointIds(
  serviceId: string,
  services: PreviewManifestService[],
) {
  return services.flatMap((consumer) =>
    (consumer.bindings ?? [])
      .filter(
        (binding) =>
          binding.exposure === "browser" &&
          binding.source.service === serviceId,
      )
      .map((binding) => binding.source.endpoint),
  );
}

function hostProbeEndpointIds(serviceId: string, manifest: PreviewManifest) {
  return (manifest.probes ?? [])
    .filter(
      (probe) => probe.from === "host" && probe.target.service === serviceId,
    )
    .map((probe) => probe.target.endpoint);
}

function serviceHealthcheckYaml(service: PreviewManifestService) {
  return (
    knownDependencyHealthcheckYaml(service) ?? declaredHealthcheckYaml(service)
  );
}

function declaredHealthcheckYaml(service: PreviewManifestService) {
  const endpoint = healthcheckEndpoint(service);
  if (!endpoint) return [];
  const command = endpointHealthcheckCommand(
    containerImage(service.container),
    endpoint,
  );
  if (!command) return [];
  const healthcheck = endpoint.healthcheck;
  if (!healthcheck) return [];
  const retries = Math.max(1, Math.ceil(healthcheck.timeoutMs / 5_000));
  return [
    "    healthcheck:",
    "      test:",
    `        - CMD-SHELL`,
    `        - ${yamlString(command)}`,
    "      interval: 5s",
    "      timeout: 5s",
    `      retries: ${retries}`,
  ];
}

function healthcheckEndpoint(service: PreviewManifestService) {
  return service.endpoints.find(({ healthcheck }) => healthcheck);
}

function endpointHealthcheckCommand(
  image: string,
  endpoint: PreviewManifestEndpoint,
) {
  if (!endpoint.healthcheck) return undefined;
  if (nodeImage(image)) return nodeHealthcheckCommand(endpoint);
  if (pythonImage(image)) return pythonHealthcheckCommand(endpoint);
  return undefined;
}

function nodeHealthcheckCommand(endpoint: PreviewManifestEndpoint) {
  if (endpoint.healthcheck?.type === "tcp") {
    return waitForTcpHealthcheckCommand(endpoint.port);
  }
  const path = endpoint.healthcheck?.path ?? "/";
  const url = `${endpoint.protocol}://127.0.0.1:${endpoint.port}${path}`;
  // Ready means "answers without a server error", like cloud readiness.
  const script = `fetch(${JSON.stringify(url)}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))`;
  return `node -e ${shellQuote(script)}`;
}

function waitForTcpHealthcheckCommand(port: number) {
  const script = `const s=require("net").connect(${port},"127.0.0.1",()=>process.exit(0));s.once("error",()=>process.exit(1));s.setTimeout(4000,()=>process.exit(1))`;
  return `node -e ${shellQuote(script)}`;
}

function pythonHealthcheckCommand(endpoint: PreviewManifestEndpoint) {
  if (endpoint.healthcheck?.type === "tcp") {
    const script = `import socket;socket.create_connection(("127.0.0.1",${endpoint.port}),4).close()`;
    return `python -c ${shellQuote(script)}`;
  }
  const path = endpoint.healthcheck?.path ?? "/";
  const url = `${endpoint.protocol}://127.0.0.1:${endpoint.port}${path}`;
  const script = [
    "import sys,urllib.request,urllib.error",
    `try:\n urllib.request.urlopen(${JSON.stringify(url)},timeout=4).close()`,
    "except urllib.error.HTTPError as error:\n sys.exit(0 if error.code<500 else 1)",
  ].join("\n");
  return `python -c ${shellQuote(script)}`;
}

function knownDependencyHealthcheckYaml(service: PreviewManifestService) {
  if (service.kind !== "dependency") return undefined;
  if (!mysqlImage(containerImage(service.container))) return undefined;
  return [
    "    healthcheck:",
    "      test:",
    "        - CMD-SHELL",
    `        - ${yamlString(`mysqladmin ping -h 127.0.0.1 -uroot -p"$$MYSQL_ROOT_PASSWORD" --silent`)}`,
    "      interval: 5s",
    "      timeout: 5s",
    "      retries: 12",
  ];
}

function serviceDependencyCondition(
  id: string,
  services: PreviewManifestService[],
) {
  const dependency = services.find((service) => service.id === id);
  if (!dependency) return undefined;
  return serviceHasHealthcheck(dependency) ? "service_healthy" : undefined;
}

function setupDependencyCondition(id: string, manifest: PreviewManifest) {
  if (manifest.setup.some((task) => task.id === id)) {
    return "service_completed_successfully";
  }
  return serviceDependencyCondition(id, manifest.services);
}

function serviceHasHealthcheck(service: PreviewManifestService) {
  return !!serviceHealthcheckYaml(service).length;
}

export function mysqlImage(image: string) {
  return /^mysql(?::|$)/.test(image) || /\/mysql(?::|$)/.test(image);
}

function nodeImage(image: string) {
  return /^node(?::|$)/.test(image) || /\/node(?::|$)/.test(image);
}

function pythonImage(image: string) {
  return /^python(?::|$)/.test(image) || /\/python(?::|$)/.test(image);
}

function environmentYaml(environment: PreviewManifestEnvironment) {
  const entries = Object.entries(environment).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return [];
  return [
    "    environment:",
    ...entries.map(([key, value]) => `      ${key}: ${yamlString(value)}`),
  ];
}

function dependsOnYaml(services: Array<{ condition?: string; id: string }>) {
  const uniqueServices = uniqueDependsOnEntries(services);
  if (uniqueServices.length === 0) return [];
  return [
    "    depends_on:",
    ...uniqueServices.flatMap((service) => [
      `      ${service.id}:`,
      `        condition: ${service.condition ?? "service_started"}`,
    ]),
  ];
}

function dependsOnEntry(id: string, condition?: string) {
  return { condition, id };
}

function uniqueDependsOnEntries(
  services: Array<{ condition?: string; id: string }>,
) {
  const entries = new Map<string, { condition?: string; id: string }>();
  for (const service of services) {
    if (!service.id) continue;
    const current = entries.get(service.id);
    if (!current || service.condition) entries.set(service.id, service);
  }
  return Array.from(entries.values());
}

function volumeYaml(caches: PreviewManifestCache[], includeWorkspace: boolean) {
  if (!includeWorkspace) return [];
  return [
    "    volumes:",
    ...(includeWorkspace
      ? [`      - "\${BLAME_PROJECT_ROOT}:/workspace"`]
      : []),
    ...caches.map(
      (cache) => `      - ${yamlString(`${cache.name}:${cache.target}`)}`,
    ),
  ];
}

export function runsNodePackageManager(commands: string) {
  return /\b(?:(?:corepack\s+)?(?:pnpm|yarn)|npm|bun)\s+(?:install|ci|exec|run)\b/.test(
    commands,
  );
}

export function defaultSetupRunAs(command: string) {
  return workspacePermissionRepairCommand(command) ? "root" : "host";
}

function setupTaskRunsAsRoot(task: PreviewManifestSetupTask) {
  return task.runAs === "root";
}

function setupTaskCommand(
  task: PreviewManifestSetupTask,
  services: PreviewManifestService[],
) {
  const commands = [
    ...setupDependencyWaitCommands(task, services),
    task.command,
  ];
  if (setupTaskRunsAsRoot(task)) {
    commands.push(
      "find /workspace -maxdepth 1 \\( -name .nuxt -o -name .next -o -name .vite -o -name node_modules \\) -exec chown -R 0:0 {} +",
    );
  }
  return commands.join(" && ");
}

function setupDependencyWaitCommands(
  task: PreviewManifestSetupTask,
  services: PreviewManifestService[],
) {
  if (!nodeImage(containerImage(task.container))) return [];
  return (task.dependsOn ?? [])
    .map((id) => services.find((service) => service.id === id))
    .map(dependencyWaitTarget)
    .filter((target): target is { host: string; port: number } => !!target)
    .map((target) => waitForTcpCommand(target.host, target.port));
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

export function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
