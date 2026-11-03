import assert from "node:assert/strict";
import test from "node:test";
import type {
  PreviewExecutionPlan,
  ServiceLaunchPlan,
  SetupTaskPlan,
} from "@blame/preview-runtime";
import {
  resolvePreviewEnvironment,
  type ResolveEnvironmentInput,
} from "./environment-resolver.ts";
import { maskedEnvValue, placeholderEnvValue } from "./dotenv.ts";

function service(
  id: string,
  options: Partial<ServiceLaunchPlan> = {},
): ServiceLaunchPlan {
  return {
    id,
    kind: "preview",
    container: { image: "node:24" },
    workingDir: "/workspace",
    environment: {},
    dependsOn: [],
    endpoints: [{ id: "http", protocol: "http", port: 3333 }],
    bindings: [],
    ...options,
  };
}

function setup(
  id: string,
  options: Partial<SetupTaskPlan> = {},
): SetupTaskPlan {
  return {
    id,
    container: { image: "node:24" },
    workingDir: "/workspace",
    command: "pnpm install",
    runAs: "host",
    environment: {},
    dependsOn: [],
    ...options,
  };
}

function resolve(input: Partial<ResolveEnvironmentInput>) {
  return resolvePreviewEnvironment({
    plan: { services: [service("api")], setup: [] } as Pick<
      PreviewExecutionPlan,
      "services" | "setup"
    >,
    bindings: {},
    databaseMode: "existing",
    envFiles: [],
    project: [],
    story: [],
    ...input,
  });
}

function variable(result: ReturnType<typeof resolve>, id: string, key: string) {
  return result.items
    .find((item) => item.id === id)
    ?.variables.find((entry) => entry.key === key);
}

test("takes each key from its strongest layer", () => {
  const result = resolve({
    plan: {
      services: [
        service("api", {
          environment: { NODE_ENV: "development", FEATURE: "manifest" },
          bindings: [
            {
              targetKey: "QUEUE_URL",
              sourceServiceId: "queue",
              sourceEndpointId: "tcp",
              exposure: "server",
              format: "url",
              path: "",
            },
          ],
        }),
      ],
      setup: [],
    },
    bindings: { api: { QUEUE_URL: "redis://queue:6379" } },
    envFiles: [
      {
        path: ".env",
        content: "FEATURE=file\nSTRIPE_KEY=sk_test_file\nQUEUE_URL=x\n",
      },
    ],
    project: [{ key: "STRIPE_KEY", value: "sk_test_project" }],
    story: [
      { key: "STRIPE_KEY", value: "sk_test_story" },
      { key: "QUEUE_URL", value: "redis://elsewhere" },
    ],
  });
  assert.deepEqual(
    ["NODE_ENV", "FEATURE", "STRIPE_KEY", "QUEUE_URL"].map((key) => {
      const entry = variable(result, "api", key)!;
      return [key, entry.value, entry.source, entry.locked];
    }),
    [
      ["NODE_ENV", "development", "manifest", false],
      ["FEATURE", "file", "env-file", false],
      ["STRIPE_KEY", "sk_test_story", "story", false],
      ["QUEUE_URL", "redis://queue:6379", "blame-service", true],
    ],
  );
  // The container gets the stronger layers and defaults; the file carries
  // its own values, and Compose renders the binding.
  assert.deepEqual(result.items[0]!.environment, {
    NODE_ENV: "development",
    STRIPE_KEY: "sk_test_story",
  });
  assert.deepEqual(result.fileValues["."], {
    QUEUE_URL: "redis://queue:6379",
    STRIPE_KEY: "sk_test_story",
  });
});

test("reads the nearest env files first, the most specific of a directory first", () => {
  const result = resolve({
    plan: {
      services: [service("api", { workingDir: "/workspace/apps/api" })],
      setup: [],
    },
    envFiles: [
      { path: ".env", content: "SHARED=root\nROOT_ONLY=root\n" },
      { path: "apps/api/.env", content: "SHARED=api\nLOCAL=env\n" },
      { path: "apps/api/.env.local", content: "LOCAL=local\n" },
      { path: "apps/api/.env.production", content: "LOCAL=production\n" },
      { path: "apps/web/.env", content: "WEB=web\n" },
    ],
  });
  const values = Object.fromEntries(
    result.items[0]!.variables.map(({ key, value, file }) => [
      key,
      `${value} (${file})`,
    ]),
  );
  assert.deepEqual(values, {
    LOCAL: "local (apps/api/.env.local)",
    ROOT_ONLY: "root (.env)",
    SHARED: "api (apps/api/.env)",
  });
});

test("an isolated database replaces the developer's database settings", () => {
  const result = resolve({
    databaseMode: "compose",
    plan: {
      services: [
        service("api", {
          environment: {
            DATABASE_URL: "postgres://blame:blame@database:5432/app",
          },
        }),
        service("database", {
          kind: "dependency",
          container: { image: "postgres:17" },
          workingDir: "/var/lib/postgresql",
          environment: { POSTGRES_PASSWORD: "blame" },
          endpoints: [{ id: "sql", protocol: "tcp", port: 5432 }],
        }),
      ],
      setup: [],
    },
    envFiles: [
      {
        path: ".env",
        content:
          "DATABASE_URL=postgres://me:secret@127.0.0.1:5432/prod\nDB_PORT=13307\n",
      },
    ],
  });
  const url = variable(result, "api", "DATABASE_URL")!;
  assert.equal(url.source, "blame-database");
  assert.equal(url.value, "postgres://blame:blame@database:5432/app");
  assert.equal(url.locked, true);
  const port = variable(result, "api", "DB_PORT")!;
  assert.equal(port.status, "removed");
  assert.match(port.note!, /isolated database/);
  assert.equal(result.items[0]!.environment.DB_PORT, undefined);
  assert.equal(variable(result, "database", "POSTGRES_PASSWORD")!.locked, true);
});

test("the project's database keeps the developer's settings, renamed to reach their computer", () => {
  const result = resolve({
    databaseMode: "existing",
    hostAlias: "host.docker.internal",
    envFiles: [
      {
        path: ".env",
        content:
          "DATABASE_URL=postgres://me:secret@localhost:5432/app\nREDIS_URL=rediss://cache.example.com:6380\n",
      },
    ],
  });
  const url = variable(result, "api", "DATABASE_URL")!;
  assert.equal(url.value, "postgres://me:secret@host.docker.internal:5432/app");
  assert.equal(url.source, "env-file");
  assert.match(url.note!, /localhost became host.docker.internal/);
  assert.equal(
    variable(result, "api", "REDIS_URL")!.value,
    "rediss://cache.example.com:6380",
  );
  // The env file carries them; the container environment does not repeat them.
  assert.equal(result.items[0]!.environment.DATABASE_URL, undefined);
  // A value someone set in the Variables tab is renamed the same way.
  const overridden = resolve({
    databaseMode: "existing",
    hostAlias: "host.docker.internal",
    story: [{ key: "DATABASE_URL", value: "mysql://u:p@127.0.0.1:3306/app" }],
  });
  assert.equal(
    overridden.items[0]!.environment.DATABASE_URL,
    "mysql://u:p@host.docker.internal:3306/app",
  );
});

test("keeps the addresses and ports the preview needs over the developer's", () => {
  const result = resolve({
    plan: {
      services: [
        service("web", {
          environment: {
            API_URL: "http://api:3333",
            API_HOST: "api",
            HOST: "0.0.0.0",
            PORT: "3333",
          },
        }),
        service("api"),
      ],
      setup: [],
    },
    previewOrigin: "http://localhost:51000",
    envFiles: [
      {
        path: ".env",
        content:
          "API_URL=http://localhost:3333\nAPI_HOST=localhost\nHOST=localhost\nPORT=3000\nAPP_URL=http://localhost:3000/app\nCDN_URL=https://cdn.example.com\n",
      },
    ],
  });
  const entry = (key: string) => {
    const found = variable(result, "web", key)!;
    return [found.value, found.source];
  };
  assert.deepEqual(entry("API_URL"), ["http://api:3333", "blame-service"]);
  assert.deepEqual(entry("API_HOST"), ["api", "blame-service"]);
  assert.deepEqual(entry("HOST"), ["0.0.0.0", "blame-listen"]);
  assert.deepEqual(entry("PORT"), ["3333", "blame-listen"]);
  assert.deepEqual(entry("APP_URL"), [
    "http://localhost:51000/app",
    "blame-origin",
  ]);
  assert.deepEqual(entry("CDN_URL"), ["https://cdn.example.com", "env-file"]);
});

test("an example fills in for a missing .env and lists what an existing one lacks", () => {
  const plan = {
    services: [service("api")],
    setup: [setup("install")],
  };
  const example = {
    path: ".env.example",
    content: "APP_KEY=change-me\nSTRIPE_KEY=\nLOG_LEVEL=info\n",
  };
  const alone = resolve({ plan, envFiles: [example] });
  assert.deepEqual(alone.items.at(-1)!.environment, {
    APP_KEY: "change-me",
    STRIPE_KEY: "",
    LOG_LEVEL: "info",
  });
  assert.equal(variable(alone, "api", "APP_KEY")!.status, "placeholder");
  assert.equal(variable(alone, "api", "STRIPE_KEY")!.status, "missing");
  const beside = resolve({
    plan,
    envFiles: [example, { path: ".env", content: "APP_KEY=real-key-123\n" }],
  });
  assert.deepEqual(beside.items.at(-1)!.environment, {});
  assert.equal(variable(beside, "api", "APP_KEY")!.status, "set");
  assert.equal(variable(beside, "api", "LOG_LEVEL")!.status, "missing");
});

test("a variable for one service wins over one for every service", () => {
  const result = resolve({
    plan: { services: [service("api"), service("web")], setup: [] },
    project: [
      { key: "FLAG", value: "all" },
      { key: "FLAG", value: "api-only", serviceId: "api" },
    ],
  });
  assert.equal(variable(result, "api", "FLAG")!.value, "api-only");
  assert.equal(variable(result, "web", "FLAG")!.value, "all");
  // Two services of one directory disagree: the file keeps its own value.
  assert.equal(result.fileValues["."]!.FLAG, undefined);
});

test("declared keys nothing sets are missing", () => {
  const result = resolve({
    declarations: {
      ".": [{ key: "SESSION_DRIVER", required: true, file: "start/env.ts" }],
    },
  });
  const entry = variable(result, "api", "SESSION_DRIVER")!;
  assert.equal(entry.status, "missing");
  assert.equal(entry.required, true);
  assert.deepEqual(result.items[0]!.environment, {});
});

test("tells placeholders and secrets apart", () => {
  for (const value of [
    "<your key>",
    "change-me",
    "your-api-key",
    "xxxx",
    "paste-key-here",
  ])
    assert.equal(placeholderEnvValue(value), true, value);
  for (const value of [
    "sk_test_123",
    "info",
    "${DB_USER}",
    "none",
    "localhost",
  ])
    assert.equal(placeholderEnvValue(value), false, value);
  assert.deepEqual(maskedEnvValue("DB_PASSWORD", "hunter2"), {
    value: "••••••••",
    masked: true,
  });
  assert.deepEqual(
    maskedEnvValue("DATABASE_URL", "postgres://me:secret@db:5432/app"),
    { value: "postgres://me:••••••@db:5432/app", masked: true },
  );
  assert.equal(
    maskedEnvValue("MAC_CSC_LINK", "MIIMrwIBAzCCDHYGCSqGSIb3DQEHAaCCDGcEggxj")
      .masked,
    true,
  );
  assert.equal(
    maskedEnvValue("BLAME_AGENT_MAX_INPUT_TOKENS", "200000").masked,
    false,
  );
  assert.equal(
    maskedEnvValue("DOWNLOAD_URL", "https://download.example.com/v5/a.qcow2")
      .masked,
    false,
  );
  assert.deepEqual(maskedEnvValue("LOG_LEVEL", "info"), {
    value: "info",
    masked: false,
  });
});
