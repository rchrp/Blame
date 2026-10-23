import assert from "node:assert/strict";
import test from "node:test";
import { compilePreviewManifest } from "./manifest-compiler.js";
import { resolveCapabilities } from "./capability-resolver.js";

const manifest = {
  confidence: "high",
  project: {},
  setup: [],
  services: [
    {
      id: "frontend",
      kind: "preview",
      container: { image: "node:24" },
      command: "pnpm dev",
      endpoints: [
        {
          id: "http",
          protocol: "http",
          port: 3000,
          healthcheck: { type: "http", path: "/", timeoutMs: 30000 },
        },
      ],
      bindings: [
        {
          target: { type: "environment", key: "API_URL" },
          source: { service: "backend", endpoint: "http" },
          exposure: "browser",
        },
      ],
    },
    {
      id: "backend",
      kind: "preview",
      container: {
        build: { context: ".", dockerfile: "Dockerfile", target: "api" },
      },
      command: "pnpm api",
      endpoints: [
        {
          id: "http",
          protocol: "http",
          port: 3333,
          healthcheck: { type: "http", path: "/health", timeoutMs: 30000 },
        },
      ],
    },
  ],
  caches: [],
  risks: [],
  probes: [],
} as const;

test("compiles provider-neutral listeners and localhost compatibility", () => {
  const plan = compilePreviewManifest(manifest, {
    compatibilityHints: [
      {
        type: "server-localhost",
        consumerServiceId: "frontend",
        targetServiceId: "backend",
        port: 3333,
      },
      { type: "client-localhost", targetServiceId: "backend", port: 3333 },
      { type: "websocket" },
    ],
  });
  assert.equal(plan.workspaceRoot, "/workspace");
  assert.deepEqual(
    plan.networking.gatewayListeners.map(({ sandboxPort }) => sandboxPort),
    [43000, 43001],
  );
  assert.equal(plan.networking.requiresSharedLoopback, true);
  assert.equal(plan.networking.integratedPreviewRequired, true);
  assert.equal(resolveCapabilities("vercel-compose", plan).compatible, true);
  assert.equal(resolveCapabilities("local-container", plan).compatible, false);
});

test("refuses cloud plans over the provider port budget", () => {
  const plan = compilePreviewManifest(manifest);
  plan.networking.publishedPortCount = 16;
  const report = resolveCapabilities("vercel-compose", plan);
  assert.equal(report.compatible, false);
  assert.ok(
    report.incompatibilities.some(({ code }) => code === "PORT_LIMIT_EXCEEDED"),
  );
});

test("rejects secret plans until a credential broker is available", () => {
  const plan = compilePreviewManifest(manifest);
  plan.environmentPlan.entries.push({
    key: "DATABASE_PASSWORD",
    scope: "service",
    classification: "secret",
    delivery: "brokered-header",
    source: "story",
    serviceId: "backend",
    snapshot: "never",
  });
  const report = resolveCapabilities("vercel-compose", plan);
  assert.equal(report.compatible, false);
  assert.ok(
    report.incompatibilities.some(
      ({ capability }) => capability === "credentialBroker",
    ),
  );
});

test("allows service-scoped endpoint ids", () => {
  const duplicate = {
    ...manifest,
    services: [
      ...manifest.services,
      {
        id: "admin",
        kind: "preview",
        container: { image: "node:24" },
        command: "pnpm admin",
        endpoints: [
          {
            id: "http",
            protocol: "http",
            port: 3001,
            healthcheck: { type: "http", path: "/", timeoutMs: 30000 },
          },
        ],
      },
    ],
  };
  assert.deepEqual(
    compilePreviewManifest(duplicate).networking.gatewayListeners.map(
      ({ routeKey }) => routeKey,
    ),
    ["frontend:http", "backend:http", "admin:http"],
  );
});

test("records explicit environment scopes and accepts development values", () => {
  const plan = compilePreviewManifest(manifest);
  assert.ok(
    plan.environmentPlan.entries.some(
      (entry) =>
        entry.key === "API_URL" &&
        entry.scope === "client-public" &&
        entry.source === "runtime-binding",
    ),
  );
  const development = {
    ...manifest,
    services: [
      { ...manifest.services[0], environment: { NEXTAUTH_SECRET: "dev" } },
      manifest.services[1],
    ],
  };
  const compiled = compilePreviewManifest(development);
  assert.equal(compiled.services[0]?.environment.NEXTAUTH_SECRET, "dev");
  assert.ok(
    compiled.environmentPlan.entries.some(
      (entry) =>
        entry.key === "NEXTAUTH_SECRET" &&
        entry.classification === "non-secret" &&
        entry.delivery === "literal",
    ),
  );
  const unsafe = {
    ...manifest,
    services: [
      {
        ...manifest.services[0],
        environment: { STRIPE_KEY: `sk_live_${"a".repeat(24)}` },
      },
      manifest.services[1],
    ],
  };
  assert.throws(() => compilePreviewManifest(unsafe), /live Stripe key/);
});

test("compiles public throwaway isolated database credentials as literals", () => {
  const isolated = {
    ...manifest,
    setup: [
      {
        id: "migrate",
        container: { image: "node:24" },
        command: "pnpm migrate",
        environment: { DB_PASSWORD: "blame" },
      },
    ],
  };
  const plan = compilePreviewManifest(isolated);

  assert.equal(plan.setup[0]?.environment.DB_PASSWORD, "blame");
  assert.ok(
    plan.environmentPlan.entries.some(
      (entry) =>
        entry.key === "DB_PASSWORD" &&
        entry.classification === "non-secret" &&
        entry.delivery === "literal",
    ),
  );
});

test("orders setup dependencies and keeps them out of the service graph", () => {
  const withSetup = {
    ...manifest,
    setup: [
      {
        id: "generate",
        container: { image: "node:24" },
        command: "pnpm generate",
        dependsOn: ["install"],
      },
      {
        id: "install",
        container: { image: "node:24" },
        command: "pnpm install",
      },
    ],
    services: [
      { ...manifest.services[0], dependsOn: ["generate"] },
      manifest.services[1],
    ],
  };
  const plan = compilePreviewManifest(withSetup);
  assert.deepEqual(
    plan.setup.map(({ id }) => id),
    ["install", "generate"],
  );
  assert.deepEqual(plan.services[0]?.dependsOn, []);
});

test("adds server bindings to the service dependency graph", () => {
  const serverBinding = {
    ...manifest,
    services: [
      {
        ...manifest.services[0],
        bindings: manifest.services[0].bindings.map((binding) => ({
          ...binding,
          exposure: "server" as const,
        })),
      },
      manifest.services[1],
    ],
  };
  const plan = compilePreviewManifest(serverBinding);
  assert.deepEqual(plan.services[0]?.dependsOn, ["backend"]);
});

test("merges transitive localhost requirements into one loopback group", () => {
  const plan = compilePreviewManifest(
    manifestWithServices(["web", "api", "worker"]),
    {
      compatibilityHints: [
        {
          type: "server-localhost",
          consumerServiceId: "web",
          targetServiceId: "api",
          port: 3001,
        },
        {
          type: "server-localhost",
          consumerServiceId: "worker",
          targetServiceId: "web",
          port: 3000,
        },
      ],
    },
  );
  assert.deepEqual(plan.networking.loopbackGroups, [
    {
      id: "loopback:api:web:worker",
      serviceIds: ["api", "web", "worker"],
      logicalPorts: [3000, 3001],
    },
  ]);
});

function manifestWithServices(ids: string[]) {
  return {
    confidence: "high",
    project: {},
    setup: [],
    services: ids.map((id, index) => ({
      id,
      kind: id === "web" ? "preview" : "worker",
      container: { image: "node:24" },
      command: `node ${id}.js`,
      endpoints: [
        {
          id: "http",
          protocol: "http",
          port: 3000 + index,
          ...(id === "web"
            ? { healthcheck: { type: "http", path: "/", timeoutMs: 30_000 } }
            : {}),
        },
      ],
    })),
    caches: [],
    risks: [],
    probes: [],
  };
}
