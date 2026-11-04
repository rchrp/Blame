import type {
  BackendFramework,
  DatabaseOption,
  FrontendFramework,
  NewProjectConfiguration,
  OrmOption,
  PackageManager,
} from "./project-creation";

export type ProjectSetupRecipe = {
  dockerCompose: string;
  setupScript: string;
};

type RuntimePlan = {
  containerCorepackCommand: string;
  containerDevCommand: string;
  containerInstallIfNeededCommand: string;
  nodeImage: string;
  previewPort: number;
};

type ServiceSpec = {
  name: string;
  image: string;
  command?: string;
  dependsOn?: string[];
  environment?: Record<string, string>;
  labels?: Record<string, string>;
  ports?: string[];
  user?: string;
  volumes?: string[];
  workingDir?: string;
};

export function projectSetupRecipe(
  configuration: NewProjectConfiguration,
): ProjectSetupRecipe {
  const runtime = runtimePlan(configuration);
  const services = [
    ...nodeModulesServices(runtime),
    nodeAppService(configuration, runtime),
    ...backendServices(configuration),
    ...databaseServices(configuration.database),
  ];

  return {
    dockerCompose: composeYaml(services),
    setupScript: setupScript(configuration, runtime),
  };
}

export function setupScript(
  configuration: NewProjectConfiguration,
  runtime = runtimePlan(configuration),
) {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    ...hostToolChecks(configuration),
    `export COMPOSE_PROJECT_NAME="\${COMPOSE_PROJECT_NAME:-blame_$(pwd | cksum | awk '{print $1}')}"`,
    ...setupEnvironmentExports(configuration),
    ...envFileSetupCommands(),
    ...backendSetupCommands(configuration),
    ...hostOrmSetupCommands(configuration),
    "",
  ].join("\n");
}

export function dockerCompose(
  configuration: NewProjectConfiguration,
  runtime = runtimePlan(configuration),
) {
  return composeYaml([
    ...nodeModulesServices(runtime),
    nodeAppService(configuration, runtime),
    ...backendServices(configuration),
    ...databaseServices(configuration.database),
  ]);
}

export function runtimePlan(
  configuration: NewProjectConfiguration,
): RuntimePlan {
  return {
    containerCorepackCommand: containerCorepackCommand(
      configuration.packageManager,
    ),
    containerDevCommand: containerDevCommand(configuration.frontend),
    containerInstallIfNeededCommand: containerInstallIfNeededCommand(
      configuration.packageManager,
      configuration.frontend,
    ),
    nodeImage: nodeImage(configuration.packageManager),
    previewPort: previewPort(configuration.frontend),
  };
}

function nodeModulesServices(runtime: RuntimePlan): ServiceSpec[] {
  return [
    {
      name: "node-modules-init",
      image: runtime.nodeImage,
      command:
        'sh -lc "mkdir -p /workspace/node_modules && chown -R 0:0 /workspace/node_modules"',
      volumes: ["blame_node_modules:/workspace/node_modules"],
    },
  ];
}

function nodeAppService(
  configuration: NewProjectConfiguration,
  runtime: RuntimePlan,
): ServiceSpec {
  return {
    name: "app",
    image: runtime.nodeImage,
    workingDir: "/workspace",
    command: `sh -lc "${runtime.containerCorepackCommand} && ${runtime.containerInstallIfNeededCommand} && ${containerOrmSetupCommand(configuration)} && ${runtime.containerDevCommand}"`,
    volumes: [
      "${BLAME_PROJECT_ROOT}:/workspace",
      "blame_node_modules:/workspace/node_modules",
    ],
    ports: [`127.0.0.1::${runtime.previewPort}`],
    environment: nodeEnvironment(configuration),
    dependsOn: ["node-modules-init", ...serviceDependencies(configuration)],
    labels: {
      "blame.preview": "true",
      "blame.preview.port": String(runtime.previewPort),
      "blame.preview.protocol": "http",
      "blame.preview.path": "/",
    },
  };
}

function backendServices(
  configuration: NewProjectConfiguration,
): ServiceSpec[] {
  if (nodeBackendService(configuration.backend)) {
    return [
      {
        name: "api",
        image: runtimePlan(configuration).nodeImage,
        workingDir: "/workspace",
        command: `sh -lc "${containerCorepackCommand(configuration.packageManager)} && ${containerWaitForFrontendDependenciesCommand(configuration.frontend)} && ${nodeApiCommand(configuration.backend, configuration.packageManager)}"`,
        volumes: [
          "${BLAME_PROJECT_ROOT}:/workspace",
          "blame_node_modules:/workspace/node_modules",
        ],
        environment: nodeApiEnvironment(configuration),
        dependsOn: [
          "node-modules-init",
          ...databaseDependency(configuration.database),
        ],
      },
    ];
  }

  if (configuration.backend !== "fastapi") return [];

  return [
    {
      name: "api",
      image: "python:3.13-slim",
      workingDir: "/workspace",
      command: `sh -lc "${pythonInstallCommand(configuration.packageManager)} && uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload"`,
      volumes: ["${BLAME_PROJECT_ROOT}:/workspace"],
      environment: pythonEnvironment(configuration),
      dependsOn: databaseDependency(configuration.database),
    },
  ];
}

function databaseServices(database: DatabaseOption): ServiceSpec[] {
  if (database === "postgresql") {
    return [
      {
        name: "database",
        image: "postgres:17-alpine",
        environment: {
          POSTGRES_DB: "blame",
          POSTGRES_PASSWORD: "blame",
          POSTGRES_USER: "blame",
        },
      },
    ];
  }

  if (database === "mysql") {
    return [
      {
        name: "database",
        image: "mysql:9",
        environment: {
          MYSQL_DATABASE: "blame",
          MYSQL_PASSWORD: "blame",
          MYSQL_ROOT_PASSWORD: "blame",
          MYSQL_USER: "blame",
        },
      },
    ];
  }

  if (database === "mongodb") {
    return [
      {
        name: "database",
        image: "mongo:8",
      },
    ];
  }

  return [];
}

function backendSetupCommands(configuration: NewProjectConfiguration) {
  if (configuration.backend !== "fastapi") return [];
  return [pythonInstallCommand(configuration.packageManager)];
}

function hostToolChecks(configuration: NewProjectConfiguration) {
  return [...toolChecks(["git"]), ...pythonToolChecks(configuration)];
}

function toolChecks(commands: string[]) {
  return commands.map(
    (command) =>
      `command -v ${command} >/dev/null || { echo "Missing required tool: ${command}" >&2; exit 1; }`,
  );
}

function pythonToolChecks(configuration: NewProjectConfiguration) {
  if (configuration.backend !== "fastapi") return [];
  if (configuration.packageManager === "poetry") return toolChecks(["pip"]);
  if (configuration.packageManager === "pip") return toolChecks(["pip"]);
  return toolChecks(["pip"]);
}

function setupEnvironmentExports(configuration: NewProjectConfiguration) {
  return Object.entries({
    ...nodeEnvironment(configuration),
    ...pythonEnvironment(configuration),
  }).map(
    ([key, value]) =>
      `export ${key}="\${${key}:-${shellDoubleQuotedValue(value)}}"`,
  );
}

function envFileSetupCommands() {
  return [
    "if [ ! -f .env ]; then",
    "  if [ -f .env.example ]; then cp .env.example .env;",
    "  elif [ -f .env.sample ]; then cp .env.sample .env;",
    "  elif [ -f .env.template ]; then cp .env.template .env;",
    "  fi",
    "fi",
  ];
}

function hostOrmSetupCommands(configuration: NewProjectConfiguration) {
  if (configuration.orm === "sqlalchemy" || configuration.orm === "sqlmodel") {
    return [
      `if [ -f alembic.ini ]; then ${pythonRunner(configuration.packageManager, "alembic upgrade head")}; fi`,
    ];
  }
  return [];
}

function nodeEnvironment(configuration: NewProjectConfiguration) {
  return compactRecord({
    DATABASE_URL: databaseUrl(configuration.database, configuration.orm),
    NEXT_PUBLIC_API_URL: externalApiUrl(configuration.backend),
    VITE_API_URL: externalApiUrl(configuration.backend),
  });
}

function nodeApiEnvironment(configuration: NewProjectConfiguration) {
  return compactRecord({
    DATABASE_URL: databaseUrl(configuration.database, configuration.orm),
    PORT: "4000",
  });
}

function pythonEnvironment(configuration: NewProjectConfiguration) {
  return compactRecord({
    DATABASE_URL: databaseUrl(configuration.database, configuration.orm),
  });
}

function serviceDependencies(configuration: NewProjectConfiguration) {
  return [
    ...(separateApiBackend(configuration.backend) ? ["api"] : []),
    ...databaseDependency(configuration.database),
  ];
}

function separateApiBackend(backend: BackendFramework) {
  return backend === "fastapi" || nodeBackendService(backend);
}

function nodeBackendService(backend: BackendFramework) {
  return backend === "hono" || backend === "fastify" || backend === "nest";
}

function externalApiUrl(backend: BackendFramework) {
  if (backend === "fastapi") return "http://localhost:8000";
  if (nodeBackendService(backend)) return "http://localhost:4000";
  return undefined;
}

function nodeApiCommand(
  backend: BackendFramework,
  packageManager: PackageManager,
) {
  const label = backendLabel(backend);
  const runner = containerPackageCommand(packageManager);
  return `if npm run | grep -q "dev:api"; then ${runner} run dev:api -- --host 0.0.0.0; else echo "Add a dev:api script for ${label} on port 4000."; tail -f /dev/null; fi`;
}

function backendLabel(backend: BackendFramework) {
  if (backend === "hono") return "Hono";
  if (backend === "fastify") return "Fastify";
  if (backend === "nest") return "NestJS";
  return "the backend";
}

function databaseDependency(database: DatabaseOption) {
  if (database === "none" || database === "sqlite") return [];
  return ["database"];
}

function databaseUrl(database: DatabaseOption, orm: OrmOption) {
  if (database === "postgresql")
    return "postgresql://blame:blame@database:5432/blame";
  if (database === "mysql") return "mysql://blame:blame@database:3306/blame";
  if (database === "sqlite") return "file:./dev.db";
  if (database === "mongodb") return "mongodb://database:27017/blame";
  if (orm === "prisma" || orm === "drizzle" || orm === "kysely")
    return "file:./dev.db";
  return undefined;
}

function pythonInstallCommand(packageManager: PackageManager) {
  if (packageManager === "poetry")
    return "pip install poetry && poetry install";
  if (packageManager === "pip") return "pip install -e .";
  return "pip install uv && uv sync";
}

function pythonRunner(packageManager: PackageManager, command: string) {
  if (packageManager === "poetry") return `poetry run ${command}`;
  if (packageManager === "pip") return command;
  return `uv run ${command}`;
}

function packageRunner(packageManager: PackageManager, command: string) {
  if (packageManager === "npm") return `npm exec ${command}`;
  if (packageManager === "yarn") return `yarn exec ${command}`;
  if (packageManager === "bun") return `bunx ${command}`;
  return `corepack pnpm exec ${command}`;
}

function containerPackageCommand(packageManager: PackageManager) {
  if (packageManager === "pnpm") return "corepack pnpm";
  if (packageManager === "yarn") return "corepack yarn";
  if (packageManager === "bun") return "bun";
  return "npm";
}

function containerCorepackCommand(packageManager: PackageManager) {
  if (packageManager === "pnpm")
    return "corepack prepare pnpm@10.34.9 --activate";
  if (packageManager === "yarn")
    return "corepack prepare yarn@stable --activate";
  return "true";
}

function containerInstallIfNeededCommand(
  packageManager: PackageManager,
  frontend: FrontendFramework,
) {
  const installCommand = `${containerPackageCommand(packageManager)} install`;
  return `if [ ! -e ${containerExecutablePath(frontend)} ]; then ${installCommand}; fi`;
}

function containerWaitForFrontendDependenciesCommand(
  frontend: FrontendFramework,
) {
  return `while [ ! -e ${containerExecutablePath(frontend)} ]; do sleep 1; done`;
}

function containerOrmSetupCommand(configuration: NewProjectConfiguration) {
  if (configuration.orm === "prisma")
    return `if [ -f prisma/schema.prisma ] || [ -f schema.prisma ] || [ -f prisma.config.ts ]; then ${packageRunner(configuration.packageManager, "prisma generate")}; fi`;
  if (configuration.orm === "drizzle")
    return `if [ -f drizzle.config.ts ] || [ -f drizzle.config.js ]; then ${packageRunner(configuration.packageManager, "drizzle-kit generate")}; fi`;
  return "true";
}

function nodeImage(packageManager: PackageManager) {
  if (packageManager === "bun") return "oven/bun:1";
  return "node:22-bookworm-slim";
}

function previewPort(frontend: FrontendFramework) {
  if (frontend === "next" || frontend === "nuxt") return 3000;
  return 5173;
}

function containerDevCommand(frontend: FrontendFramework) {
  if (frontend === "next")
    return `${containerExecutablePath(frontend)} dev -H 0.0.0.0`;
  if (frontend === "nuxt")
    return `${containerExecutablePath(frontend)} dev --host 0.0.0.0`;
  return `${containerExecutablePath(frontend)} --host 0.0.0.0`;
}

function containerExecutablePath(frontend: FrontendFramework) {
  if (frontend === "next") return "./node_modules/.bin/next";
  if (frontend === "nuxt") return "./node_modules/.bin/nuxt";
  return "./node_modules/.bin/vite";
}

function composeYaml(services: ServiceSpec[]) {
  return `${[
    "services:",
    ...services.flatMap(serviceYaml),
    ...volumesYaml(services),
  ].join("\n")}\n`;
}

function serviceYaml(service: ServiceSpec) {
  return [
    `  ${service.name}:`,
    `    image: ${service.image}`,
    ...stringField("user", service.user),
    ...stringField("working_dir", service.workingDir),
    ...stringField("command", service.command),
    ...listField("volumes", service.volumes),
    ...listField("ports", service.ports),
    ...mapField("environment", service.environment),
    ...listField("depends_on", service.dependsOn),
    ...mapField("labels", service.labels),
  ];
}

function stringField(name: string, value: string | undefined) {
  return value ? [`    ${name}: ${quote(value)}`] : [];
}

function listField(name: string, values: string[] | undefined) {
  if (!values?.length) return [];
  return [`    ${name}:`, ...values.map((value) => `      - ${quote(value)}`)];
}

function mapField(name: string, values: Record<string, string> | undefined) {
  if (!values || Object.keys(values).length === 0) return [];
  return [
    `    ${name}:`,
    ...Object.entries(values).map(
      ([key, value]) => `      ${key}: ${quote(value)}`,
    ),
  ];
}

function volumesYaml(services: ServiceSpec[]) {
  if (!services.some((service) => service.volumes?.some(isNodeModulesVolume)))
    return [];
  return ["volumes:", "  blame_node_modules:"];
}

function isNodeModulesVolume(volume: string) {
  return volume.startsWith("blame_node_modules:");
}

function compactRecord(values: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}

function quote(value: string) {
  return JSON.stringify(value);
}

function shellDoubleQuotedValue(value: string) {
  return value.replace(/["\\$`]/g, "\\$&");
}
