import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProjectInitializationPayload,
  projectInitializationPrompt,
} from "./project-initialization.js";
import { parsePreviewManifest } from "./preview-manifest.js";
import type { PreviewManifest, ProjectRunConfiguration } from "./types.js";

test("initialization validates and retains evidence-based cloud exclusions", () => {
  const rules = [
    {
      pattern: "/archives/**",
      reason: "Historical experiment exports unused by build or runtime",
    },
  ];
  const result = parseProjectInitializationPayload({
    ...canonicalResult(),
    cloudPreviewIgnore: rules,
  });
  assert.deepEqual(result.cloudPreviewIgnore, rules);
  assert.throws(
    () =>
      parseProjectInitializationPayload({
        ...canonicalResult(),
        cloudPreviewIgnore: [{ pattern: "/**", reason: "Too big" }],
      }),
    /exact rooted paths/,
  );
  assert.equal(
    parseProjectInitializationPayload(canonicalResult()).cloudPreviewIgnore,
    undefined,
  );
});

function canonicalResult(): {
  previewManifest: PreviewManifest;
  runConfigurations: ProjectRunConfiguration[];
} {
  return {
    previewManifest: {
      confidence: "high",
      project: {
        root: ".",
        detectedStack: ["node", "nextjs", "pnpm"],
        confidence: "high",
      },
      setup: [
        {
          id: "deps",
          container: { image: "node:22-bookworm" },
          workingDir: "/workspace",
          command:
            "corepack prepare pnpm@10.33.2 --activate && corepack pnpm install",
        },
      ],
      services: [
        {
          id: "api",
          kind: "worker",
          container: { image: "node:22-bookworm" },
          workingDir: "/workspace",
          command: "node server.js",
          endpoints: [
            {
              id: "http",
              protocol: "http",
              port: 3333,
              healthcheck: { type: "tcp", timeoutMs: 30_000 },
            },
          ],
        },
        {
          id: "app",
          kind: "preview",
          container: { image: "node:22-bookworm" },
          workingDir: "/workspace",
          command:
            "corepack prepare pnpm@10.33.2 --activate && corepack pnpm dev",
          dependsOn: ["api"],
          endpoints: [
            {
              id: "http",
              protocol: "http",
              port: 3000,
              healthcheck: {
                type: "http",
                path: "/",
                timeoutMs: 30_000,
              },
            },
          ],
          bindings: [
            {
              target: { type: "environment", key: "SERVER_API_URL" },
              source: { service: "api", endpoint: "http" },
              exposure: "server",
              format: "url",
            },
            {
              target: { type: "environment", key: "PUBLIC_API_URL" },
              source: { service: "api", endpoint: "http" },
              exposure: "browser",
              format: "url",
              path: "/api",
            },
          ],
        },
      ],
      caches: [],
      risks: [],
      probes: [
        {
          id: "api-through-app",
          from: "host",
          target: { service: "app", endpoint: "http", path: "/api/health" },
          type: "http",
          acceptedStatuses: [200, 401, 403, 404],
          required: true,
        },
      ],
    },
    runConfigurations: [
      {
        id: "web",
        name: "Web application",
        command: "pnpm dev",
        cwd: ".",
        default: true,
        category: "web",
        services: ["app"],
        previewService: "app",
        scopes: ["frontend", "backend"],
        previewUrl: "http://localhost:3000",
      },
    ],
  };
}

test("native targets select a mobile configuration without a browser URL", () => {
  const value = canonicalResult();
  value.previewManifest.devices = [
    {
      id: "iphone",
      platform: "ios",
      projectDir: ".",
      toolchain: "xcode",
      build: { project: "App.xcodeproj", scheme: "App" },
      app: { bundleId: "com.example.App" },
    },
  ];
  value.runConfigurations = [
    {
      id: "iphone",
      name: "iPhone",
      command: "xcodebuild build",
      cwd: ".",
      default: true,
      category: "mobile",
      services: [],
      previewTarget: "iphone",
      scopes: ["ios"],
    },
  ];
  assert.equal(
    parseProjectInitializationPayload(value).runConfigurations[0]!
      .previewTarget,
    "iphone",
  );
  value.runConfigurations[0]!.services = ["app"];
  value.previewManifest.devices[0]!.dependsOn = ["app"];
  assert.doesNotThrow(
    () => parseProjectInitializationPayload(value),
    "A native app may depend on a preview service such as Metro",
  );
  value.runConfigurations[0]!.previewService = "app";
  assert.throws(
    () => parseProjectInitializationPayload(value),
    /cannot select|at most one/,
  );
});

test("device targets submitted next to the manifest move inside it", () => {
  const value = canonicalResult();
  const device = {
    id: "iphone",
    platform: "ios",
    projectDir: ".",
    toolchain: "xcode",
    build: { project: "App.xcodeproj", scheme: "App" },
    app: { bundleId: "com.example.App" },
  };
  const result = parseProjectInitializationPayload({
    ...value,
    devices: [device],
    runConfigurations: [
      {
        id: "iphone",
        name: "iPhone",
        command: "xcodebuild build",
        cwd: ".",
        default: true,
        category: "mobile",
        services: [],
        previewTarget: "iphone",
        scopes: ["ios"],
      },
    ],
  });
  assert.equal(result.previewManifest.devices?.[0]?.id, "iphone");
  assert.equal(result.runConfigurations[0]!.previewTarget, "iphone");
});

test("normalizes the canonical unversioned manifest", () => {
  const result = parseProjectInitializationPayload(canonicalResult());

  assert.equal(result.previewManifest?.services[1]?.kind, "preview");
  assert.deepEqual(Object.keys(result).sort(), [
    "previewManifest",
    "runConfigurations",
  ]);
  assert.match(
    result.previewManifest?.setup[0]?.command ?? "",
    /corepack enable --install-directory "\$\$COREPACK_HOME\/bin"/,
  );
  assert.match(
    result.previewManifest?.services[1]?.command ?? "",
    /export PATH="\$\$COREPACK_HOME\/bin:\$\$PATH"/,
  );
  const app = result.previewManifest.services[1]!;
  assert.equal(app.environment?.SERVER_API_URL, "http://api:3333");
  assert.equal(
    app.environment?.PUBLIC_API_URL,
    "http://localhost:__BLAME_PREVIEW_PORT_api_3333__/api",
  );
  assert.ok(app.dependsOn?.includes("api"));
});

test("waits for long-running setup dependencies without treating them as one-shot tasks", () => {
  const input = canonicalResult();
  input.previewManifest.services.unshift({
    id: "db",
    kind: "dependency",
    container: { image: "mysql:8.0" },
    environment: {
      MYSQL_DATABASE: "app",
      MYSQL_ROOT_PASSWORD: "secret",
    },
    endpoints: [{ id: "mysql", protocol: "tcp", port: 3306 }],
  });
  const api = input.previewManifest.services.find(({ id }) => id === "api")!;
  api.dependsOn = ["db"];
  api.environment = {
    DB_DATABASE: "app",
    DB_HOST: "db",
    DB_PASSWORD: "secret",
    DB_PORT: "3306",
    DB_USER: "app",
  };
  input.previewManifest.setup.push({
    id: "migrations",
    container: { image: "node:22-bookworm" },
    workingDir: "/workspace",
    command: "node migrate.js",
    dependsOn: ["deps", "db"],
  });

  const result = parseProjectInitializationPayload(input, undefined, {
    database: { mode: "compose" },
  });

  const migrations = result.previewManifest.setup.find(
    ({ id }) => id === "migrations",
  );
  assert.deepEqual(migrations?.dependsOn, ["deps", "db"]);
  assert.equal(migrations?.environment?.DB_HOST, "db");
  assert.equal(migrations?.environment?.DB_PORT, "3306");
});

test("normalizes pnpm serve options and browser-only dependencies", () => {
  const input = canonicalResult();
  const app = input.previewManifest.services[1]!;
  app.command =
    "corepack prepare pnpm@10.33.2 --activate && corepack pnpm --filter @blame/app dev -- --hostname 0.0.0.0";
  app.bindings = app.bindings?.filter(({ exposure }) => exposure === "browser");

  const result = parseProjectInitializationPayload(input);
  const normalizedApp = result.previewManifest?.services[1];

  assert.match(normalizedApp?.command ?? "", /dev --hostname 0\.0\.0\.0/);
  assert.doesNotMatch(normalizedApp?.command ?? "", /dev -- --hostname/);
  assert.deepEqual(normalizedApp?.dependsOn, []);
});

test("adds the Nuxt server counterpart for a public service binding", () => {
  const input = canonicalResult();
  input.previewManifest.project.detectedStack = ["node", "nuxt", "pnpm"];
  const app = input.previewManifest.services[1]!;
  app.dependsOn = [];
  app.bindings = [
    {
      target: { type: "environment", key: "NUXT_PUBLIC_API_BASE_URL" },
      source: { service: "api", endpoint: "http" },
      exposure: "browser",
      format: "url",
    },
  ];

  const result = parseProjectInitializationPayload(input);
  const normalizedApp = result.previewManifest.services[1]!;

  assert.deepEqual(
    normalizedApp.bindings?.map(({ target, exposure }) => ({
      key: target.key,
      exposure,
    })),
    [
      { key: "NUXT_PUBLIC_API_BASE_URL", exposure: "browser" },
      { key: "NUXT_API_BASE_URL", exposure: "server" },
    ],
  );
  assert.equal(
    normalizedApp.environment?.NUXT_PUBLIC_API_BASE_URL,
    "http://localhost:__BLAME_PREVIEW_PORT_api_3333__",
  );
  assert.equal(normalizedApp.environment?.NUXT_API_BASE_URL, "http://api:3333");
  assert.deepEqual(normalizedApp.dependsOn, ["api"]);
});

test("requires the canonical manifest and rejects unknown manifest fields", () => {
  assert.throws(
    () => parseProjectInitializationPayload({ runConfigurations: [] }),
    /missing previewManifest/,
  );
  assert.throws(
    () =>
      parseProjectInitializationPayload({
        ...canonicalResult(),
        previewManifest: { ...canonicalResult().previewManifest, version: 3 },
      }),
    /unsupported field version/,
  );
  assert.throws(
    () =>
      parseProjectInitializationPayload({
        ...canonicalResult(),
        previewManifest: {
          ...canonicalResult().previewManifest,
          services: canonicalResult().previewManifest.services.map(
            (service) => ({
              ...service,
              source: { type: "image" },
            }),
          ),
        },
      }),
    /unsupported field source/,
  );
});

test("rejects removed artifact fields and incomplete run configurations", () => {
  assert.throws(
    () =>
      parseProjectInitializationPayload({
        ...canonicalResult(),
        setupScript: "pnpm install",
      }),
    /unsupported field setupScript/,
  );
  const input = canonicalResult();
  const configuration = { ...input.runConfigurations[0] } as Record<
    string,
    unknown
  >;
  delete configuration.services;
  assert.throws(
    () =>
      parseProjectInitializationPayload({
        ...input,
        runConfigurations: [configuration],
      }),
    /services is invalid/,
  );
});

test("supports a controlled Docker build as the sole container source", () => {
  const value = canonicalResult();
  value.previewManifest.services[1] = {
    ...value.previewManifest.services[1],
    container: {
      build: { context: "apps/web", dockerfile: "Dockerfile", target: "dev" },
    },
  };

  const result = parseProjectInitializationPayload(value);
  assert.deepEqual(result.previewManifest.services[1]?.container, {
    build: { context: "apps/web", dockerfile: "Dockerfile", target: "dev" },
  });
});

test("allows the same endpoint id on multiple services", () => {
  const manifest = parsePreviewManifest(canonicalResult().previewManifest);
  assert.deepEqual(
    manifest.services.map(({ id, endpoints }) => `${id}:${endpoints[0]?.id}`),
    ["api:http", "app:http"],
  );
});

test("supports persistent workers without browser ports", () => {
  const value = canonicalResult();
  value.previewManifest.services = [
    {
      id: "worker",
      kind: "worker",
      container: { image: "python:3.13-slim" },
      workingDir: "/workspace",
      command: "python worker.py",
      endpoints: [],
    },
  ];
  value.previewManifest.probes = [];
  value.runConfigurations = [
    {
      id: "worker",
      name: "Worker",
      command: "python worker.py",
      cwd: ".",
      default: true,
      category: "service",
      services: ["worker"],
      scopes: ["worker"],
    },
  ];

  const result = parseProjectInitializationPayload(value);
  assert.equal(result.previewManifest.services[0]?.kind, "worker");
  assert.deepEqual(result.previewManifest.services[0]?.endpoints, []);
});

test("uses webpack for Next preview services", () => {
  const result = parseProjectInitializationPayload(canonicalResult());
  assert.match(
    result.previewManifest.services[1]?.command ?? "",
    /corepack pnpm dev --webpack/,
  );
});

test("normalizes isolated database passwords before manifest validation", () => {
  const value = canonicalResult();
  value.previewManifest.setup[0]!.environment = {
    DATABASE_URL: "mysql://app:copied-password@database:3306/app",
    DB_PASSWORD: "copied-password",
  };
  value.previewManifest.services.push({
    id: "database",
    kind: "dependency",
    container: { image: "mysql:9" },
    environment: {
      MYSQL_DATABASE: "app",
      MYSQL_PASSWORD: "copied-password",
      MYSQL_ROOT_PASSWORD: "copied-root-password",
      MYSQL_USER: "app",
    },
    endpoints: [{ id: "mysql", protocol: "tcp", port: 3306 }],
  });

  const result = parseProjectInitializationPayload(value, undefined, {
    database: { mode: "compose" },
  });

  assert.deepEqual(result.previewManifest?.setup[0]?.environment, {
    DATABASE_URL: "mysql://app:blame@database:3306/app",
    DB_PASSWORD: "blame",
    COREPACK_HOME: "/tmp/corepack-cache",
    npm_config_store_dir: "/pnpm/store",
  });
  assert.equal(
    result.previewManifest?.services.at(-1)?.environment?.MYSQL_PASSWORD,
    "blame",
  );
  assert.equal(
    result.previewManifest?.services.at(-1)?.environment?.MYSQL_ROOT_PASSWORD,
    "blame",
  );
  assert.doesNotMatch(
    JSON.stringify(result.previewManifest),
    /copied-password/,
  );
});

test("explains how to repair a database URL binding without changing TCP to HTTP", () => {
  const value = canonicalResult();
  value.previewManifest.services.push({
    id: "database",
    kind: "dependency",
    container: { image: "postgres:17" },
    environment: {
      POSTGRES_USER: "blame",
      POSTGRES_PASSWORD: "blame",
      POSTGRES_DB: "blame",
    },
    endpoints: [{ id: "postgres", protocol: "tcp", port: 5432 }],
  });
  const app = value.previewManifest.services[1]!;
  app.bindings!.push({
    target: { type: "environment", key: "DATABASE_URL" },
    source: { service: "database", endpoint: "postgres" },
    exposure: "server",
  });
  assert.throws(
    () => parseProjectInitializationPayload(value),
    /app\.DATABASE_URL.*database\.postgres.*complete database URI.*dependsOn/,
  );

  app.bindings = app.bindings!.filter(
    ({ target }) => target.key !== "DATABASE_URL",
  );
  app.environment = {
    DATABASE_URL: "postgresql://blame:blame@database:5432/blame",
  };
  app.dependsOn = ["api", "database"];
  const parsed = parseProjectInitializationPayload(value);
  assert.equal(
    parsed.previewManifest.services[1]!.environment!.DATABASE_URL,
    app.environment.DATABASE_URL,
  );
  assert.ok(
    parsed.previewManifest.services[1]!.dependsOn!.includes("database"),
  );
  assert.equal(
    parsed.previewManifest.services.at(-1)!.endpoints[0]!.protocol,
    "tcp",
  );
});

test("accepts separate TCP host and port bindings", () => {
  const value = canonicalResult();
  value.previewManifest.services.push({
    id: "cache",
    kind: "dependency",
    container: { image: "redis:7" },
    endpoints: [{ id: "redis", protocol: "tcp", port: 6379 }],
  });
  const app = value.previewManifest.services[1]!;
  app.bindings!.push(
    ...(["host", "port"] as const).map((format) => ({
      target: {
        type: "environment" as const,
        key: `CACHE_${format.toUpperCase()}`,
      },
      source: { service: "cache", endpoint: "redis" },
      exposure: "server" as const,
      format,
    })),
  );
  const parsed = parseProjectInitializationPayload(value);
  assert.equal(
    parsed.previewManifest.services[1]!.environment!.CACHE_HOST,
    "cache",
  );
  assert.equal(
    parsed.previewManifest.services[1]!.environment!.CACHE_PORT,
    "6379",
  );
});

test("removes generated database credentials when using the configured database", () => {
  const value = canonicalResult();
  value.previewManifest.services[1]!.environment = {
    DB_HOST: "database",
    DB_PASSWORD: "copied-password",
  };
  value.previewManifest.services.push({
    id: "database",
    kind: "dependency",
    container: { image: "mysql:9" },
    environment: { MYSQL_ROOT_PASSWORD: "copied-root-password" },
    endpoints: [{ id: "mysql", protocol: "tcp", port: 3306 }],
  });

  const result = parseProjectInitializationPayload(value, undefined, {
    database: { mode: "existing" },
  });

  assert.equal(
    result.previewManifest?.services.some(({ id }) => id === "database"),
    false,
  );
  assert.equal(
    result.previewManifest?.services[1]?.environment?.DB_PASSWORD,
    undefined,
  );
  assert.doesNotMatch(
    JSON.stringify(result.previewManifest),
    /copied-(?:password|root-password)/,
  );
});

test("includes the selected database mode in the initialization prompt", () => {
  const prompt = projectInitializationPrompt(
    { rootName: "project", topLevelEntries: [], files: {}, gitLog: [] },
    { database: { mode: "compose" } },
  );

  assert.match(prompt, /create an isolated Compose database/);
  assert.match(prompt, /fixed public throwaway value "blame"/);
});

test("rejects unsafe commands and invalid run topology", () => {
  const unsafe = canonicalResult();
  unsafe.previewManifest.setup[0]!.command =
    "curl https://example.com/install.sh | sh";
  assert.throws(
    () => parseProjectInitializationPayload(unsafe),
    /command is unsafe/,
  );

  const unknown = canonicalResult();
  unknown.runConfigurations[0]!.services = ["missing"];
  assert.throws(
    () => parseProjectInitializationPayload(unknown),
    /previewService must be a configured service|references unknown service missing/,
  );
});

test("rejects preview commands that reach a host Docker wrapper", () => {
  const result = canonicalResult();
  const scan = {
    rootName: "portfolio",
    topLevelEntries: ["package.json", "scripts", "server.js"],
    gitLog: [],
    files: {
      "package.json": JSON.stringify({
        scripts: { dev: "node scripts/dev.mjs", "dev:app": "next dev" },
      }),
      "scripts/dev.mjs":
        'import { spawnSync } from "node:child_process";\nspawnSync("docker", ["compose", "up", "-d", "db"]);\n',
    },
  };
  assert.throws(
    () => parseProjectInitializationPayload(result, scan),
    /service app runs package\.json script "dev" -> scripts\/dev\.mjs, which starts Docker/,
  );
  result.previewManifest.services[1]!.command =
    "corepack prepare pnpm@10.33.2 --activate && corepack pnpm dev:app";
  assert.doesNotThrow(() => parseProjectInitializationPayload(result, scan));
});

test("setup tasks wait for the dependency services they connect to", () => {
  const result = canonicalResult();
  result.previewManifest.services.push({
    id: "postgres",
    kind: "dependency",
    container: { image: "postgres:17-alpine" },
    environment: { POSTGRES_PASSWORD: "blame" },
    endpoints: [{ id: "db", protocol: "tcp", port: 5432 }],
  });
  result.previewManifest.setup.push({
    id: "db-migrate",
    container: { image: "node:22-bookworm" },
    workingDir: "/workspace",
    command: "corepack pnpm db:migrate",
    environment: {
      DATABASE_URL: "postgresql://postgres:blame@postgres:5432/app",
    },
    dependsOn: ["deps"],
  });
  const parsed = parseProjectInitializationPayload(result);
  const migrate = parsed.previewManifest.setup.find(
    ({ id }) => id === "db-migrate",
  );
  assert.deepEqual(migrate?.dependsOn, ["deps", "postgres"]);
  const deps = parsed.previewManifest.setup.find(({ id }) => id === "deps");
  assert.deepEqual(deps?.dependsOn, []);
});

test("requires the Prisma client before seeding the database", () => {
  const scan = {
    rootName: "app",
    topLevelEntries: ["package.json"],
    gitLog: [],
    files: {
      "package.json": JSON.stringify({
        scripts: { dev: "next dev", "db:seed": "tsx prisma/seed.ts" },
        dependencies: { "@prisma/client": "^7.0.0" },
      }),
    },
  };
  const seeded = canonicalResult();
  seeded.previewManifest.setup.push({
    id: "db-seed",
    container: { image: "node:22-bookworm" },
    workingDir: "/workspace",
    command: "corepack pnpm db:seed",
    dependsOn: ["deps"],
  });
  assert.throws(
    () => parseProjectInitializationPayload(seeded, scan),
    /generate the Prisma client in a setup task/,
  );
  seeded.previewManifest.setup[1]!.command =
    "corepack pnpm exec prisma generate && corepack pnpm db:seed";
  assert.doesNotThrow(() => parseProjectInitializationPayload(seeded, scan));
});
