import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import type { PreviewExecutionPlan } from "../domain/execution-plan.js";
import { renderCompose, setupProfile } from "./compose-renderer.js";
import type {
  LocalComposeTarget,
  SandboxComposeTarget,
} from "./compose-target.js";

type Compose = {
  name: string;
  services: Record<string, Record<string, unknown>>;
  volumes?: Record<string, Record<string, unknown>>;
};

const sandbox: SandboxComposeTarget = {
  kind: "sandbox",
  projectUser: "1234:1234",
  proxyCertificatePath: "/etc/proxy-ca.pem",
  browserBindingUrls: { "backend:api": "https://backend.preview.example" },
};

const local: LocalComposeTarget = {
  kind: "local",
  projectName: "blame_abc123",
  workspacePath: "/home/blame/worktrees/story",
  projectUser: "1001:1001",
  hostPorts: { "frontend:web": 51000, "backend:api": 51001, "db:sql": 51002 },
  dependencyKey: "a1b2c3d4e5f6",
  fileMounts: [{ source: "/home/blame/env/story/.env", target: ".env" }],
};

test("renders hardened sandbox services with a shared loopback", () => {
  const compose = render(plan({ loopback: true }), sandbox);
  const { frontend, backend } = compose.services;
  assert.equal(compose.name, "blame-preview");
  assert.equal(backend!.network_mode, "service:frontend");
  assert.equal(backend!.ports, undefined);
  assert.deepEqual(frontend!.ports, [
    "127.0.0.1:44000:3000",
    "127.0.0.1:44001:3333",
  ]);
  assert.deepEqual(frontend!.cap_drop, ["ALL"]);
  assert.equal(frontend!.user, "1234:1234");
  assert.equal(frontend!.init, true);
  assert.deepEqual(backend!.build, {
    context: "/workspace/apps/api",
    dockerfile: "Dockerfile",
    target: "development",
  });
  const environment = frontend!.environment as Record<string, string>;
  assert.equal(environment.HOME, "/tmp/blame-home");
  assert.equal(environment.NODE_EXTRA_CA_CERTS, "/etc/proxy-ca.pem");
  assert.equal(environment.API_URL, "http://localhost:3333");
  assert.equal(environment.PUBLIC_API, "https://backend.preview.example/v1");
  assert.equal(environment.TOKEN, "price-$$5");
  assert.deepEqual(frontend!.command, [
    "/bin/sh",
    "-lc",
    'printf "%s" "$$COREPACK_HOME:$${TOKEN}:$$PATH"',
  ]);
  assert.ok(
    (frontend!.volumes as string[]).includes(
      "/workspace/.git:/workspace/.git:ro",
    ),
  );
  assert.deepEqual(compose.volumes?.["cache-blame_corepack_cache"], {
    name: "blame-preview_cache-blame_corepack_cache",
    external: true,
  });
});

test("renders local services on the worktree with host ports", () => {
  const rendered = renderCompose(plan(), local);
  const compose = parse(rendered.yaml) as Compose;
  const { frontend, backend, db } = compose.services;
  assert.equal(compose.name, "blame_abc123");
  assert.equal(frontend!.cap_drop, undefined);
  assert.equal(frontend!.user, "1001:1001");
  assert.equal(frontend!.restart, "no");
  assert.deepEqual(frontend!.ports, ["127.0.0.1:51000:3000"]);
  assert.deepEqual(db!.ports, ["127.0.0.1:51002:5432"]);
  assert.deepEqual(rendered.targets["backend:api"], {
    host: "127.0.0.1",
    port: 51001,
  });
  const environment = frontend!.environment as Record<string, string>;
  assert.equal(environment.API_URL, "http://backend:3333");
  assert.equal(environment.PUBLIC_API, "http://localhost:51001/v1");
  assert.equal(environment.NODE_EXTRA_CA_CERTS, undefined);
  assert.deepEqual(frontend!.volumes, [
    "/home/blame/worktrees/story:/workspace",
    "cache-blame_corepack_cache:/tmp/corepack-cache",
    "cache-blame_node_modules:/workspace/node_modules",
    "/home/blame/env/story/.env:/workspace/.env:ro",
  ]);
  assert.ok(
    (backend!.volumes as string[]).includes(
      "deps-apps-api:/workspace/apps/api/node_modules",
    ),
  );
  assert.deepEqual(backend!.build, {
    context: "/home/blame/worktrees/story/apps/api",
    dockerfile: "Dockerfile",
    target: "development",
  });
  assert.deepEqual(compose.volumes?.["cache-blame_node_modules"], {
    name: "blame_node_modules_a1b2c3d4e5f6",
    external: true,
  });
  assert.deepEqual(compose.volumes?.["deps-apps-api"], {
    name: "blame_node_modules_a1b2c3d4e5f6_apps_api",
    external: true,
  });
  assert.deepEqual(compose.volumes?.["cache-blame_corepack_cache"], {
    name: "blame_corepack_cache",
    external: true,
  });
  assert.ok(rendered.volumes.every(({ owner }) => owner === "project"));
});

test("orders services with Compose health conditions", () => {
  const compose = render(plan(), local);
  const { frontend, db } = compose.services;
  assert.deepEqual(frontend!.depends_on, {
    backend: { condition: "service_healthy" },
    db: { condition: "service_healthy" },
  });
  assert.deepEqual((db!.healthcheck as { test: string[] }).test, [
    "CMD-SHELL",
    "pg_isready -h 127.0.0.1 -q",
  ]);
  assert.equal(db!.working_dir, undefined);
  assert.equal(db!.user, undefined);
  assert.deepEqual(db!.volumes, [
    "cache-blame_corepack_cache:/tmp/corepack-cache",
    "cache-blame_node_modules:/workspace/node_modules",
  ]);
  const backendCheck = compose.services.backend!.healthcheck as {
    test: string[];
    start_interval: string;
  };
  assert.equal(backendCheck.test[1], "node");
  assert.match(
    backendCheck.test[3] ?? "",
    /http:\/\/127\.0\.0\.1:3333\/health/,
  );
  assert.equal(backendCheck.start_interval, "1s");
});

test("renders setup tasks as one-shot services of the setup profile", () => {
  const compose = render(plan(), local);
  const install = compose.services["setup-install"]!;
  const migrate = compose.services["setup-migrate"]!;
  assert.deepEqual(install.profiles, [setupProfile]);
  assert.equal(install.restart, "no");
  assert.equal(install.depends_on, undefined);
  assert.deepEqual(migrate.depends_on, {
    db: { condition: "service_healthy" },
  });
  assert.equal(compose.services["setup-chown"]!.user, "0:0");
  assert.ok(
    (install.volumes as string[]).includes(
      "deps-apps-api:/workspace/apps/api/node_modules",
    ),
  );
});

test("one plan renders the same services and wiring for both targets", () => {
  const cloud = render(plan(), sandbox);
  const vm = render(plan(), local);
  assert.deepEqual(Object.keys(cloud.services), Object.keys(vm.services));
  for (const [id, service] of Object.entries(cloud.services)) {
    const other = vm.services[id]!;
    assert.deepEqual(service.command, other.command, `${id} command`);
    assert.deepEqual(service.depends_on, other.depends_on, `${id} depends_on`);
    assert.deepEqual(service.healthcheck, other.healthcheck, `${id} health`);
  }
});

test("rejects build contexts that leave the workspace", () => {
  const escaping = plan();
  escaping.services[1]!.container = {
    build: { context: "../outside", dockerfile: "Dockerfile" },
  };
  assert.throws(
    () => renderCompose(escaping, local),
    (error: Error & { runnerCode?: string }) =>
      error.runnerCode === "INVALID_BUILD_CONTEXT",
  );
});

test("a local endpoint needs a host port", () => {
  assert.throws(
    () => renderCompose(plan(), { ...local, hostPorts: {} }),
    (error: Error & { runnerCode?: string }) =>
      error.runnerCode === "HOST_PORT_MISSING",
  );
});

function render(
  value: PreviewExecutionPlan,
  target: SandboxComposeTarget | LocalComposeTarget,
) {
  return parse(renderCompose(value, target).yaml) as Compose;
}

function plan(options: { loopback?: boolean } = {}): PreviewExecutionPlan {
  const node = { image: "node:24" };
  return {
    version: 2,
    workspaceRoot: "/workspace",
    setup: [
      task("install", "corepack pnpm install", []),
      task("migrate", "corepack pnpm prisma migrate deploy", ["install", "db"]),
      { ...task("chown", "chown -R 1001 /workspace/.next", []), runAs: "root" },
    ],
    services: [
      {
        id: "frontend",
        kind: "preview",
        container: node,
        workingDir: "/workspace",
        command: 'printf "%s" "$COREPACK_HOME:${TOKEN}:$$PATH"',
        environment: { TOKEN: "price-$5" },
        dependsOn: options.loopback ? [] : ["backend", "db"],
        endpoints: [{ id: "web", protocol: "http", port: 3000 }],
        bindings: [
          binding("API_URL", "server", ""),
          binding("PUBLIC_API", "browser", "/v1"),
        ],
      },
      {
        id: "backend",
        kind: "preview",
        container: {
          build: {
            context: "apps/api",
            dockerfile: "Dockerfile",
            target: "development",
          },
        },
        workingDir: "/workspace/apps/api",
        command: "node backend.js",
        environment: {},
        dependsOn: [],
        endpoints: [
          {
            id: "api",
            protocol: "http",
            port: 3333,
            healthcheck: { type: "http", path: "/health", timeoutMs: 30_000 },
          },
        ],
        bindings: [],
      },
      ...(options.loopback
        ? []
        : [
            {
              id: "db",
              kind: "dependency" as const,
              container: { image: "postgres:17-alpine" },
              workingDir: "/workspace",
              environment: { POSTGRES_PASSWORD: "blame" },
              dependsOn: [],
              endpoints: [{ id: "sql", protocol: "tcp" as const, port: 5432 }],
              bindings: [],
            },
          ]),
    ],
    caches: [
      { name: "blame_corepack_cache", target: "/tmp/corepack-cache" },
      { name: "blame_node_modules", target: "/workspace/node_modules" },
    ],
    probes: [],
    environmentPlan: { cleanupRequired: true, entries: [] },
    networking: {
      gatewayListeners: [],
      loopbackGroups: options.loopback
        ? [
            {
              id: "app",
              serviceIds: ["frontend", "backend"],
              logicalPorts: [3000, 3333],
            },
          ]
        : [],
      publishedPortCount: 0,
      browserBindingCount: 1,
      requiresSharedLoopback: Boolean(options.loopback),
      requiresWebSockets: false,
      integratedPreviewRequired: false,
      incompatibilityReasons: [],
    },
    detectedCompatibility: [{ type: "container-engine" }],
  };

  function task(id: string, command: string, dependsOn: string[]) {
    return {
      id,
      container: node,
      workingDir: "/workspace",
      command,
      runAs: "host" as const,
      environment: {},
      dependsOn,
    };
  }

  function binding(
    targetKey: string,
    exposure: "server" | "browser",
    path: string,
  ) {
    return {
      targetKey,
      sourceServiceId: "backend",
      sourceEndpointId: "api",
      exposure,
      format: "url" as const,
      path,
    };
  }
}
