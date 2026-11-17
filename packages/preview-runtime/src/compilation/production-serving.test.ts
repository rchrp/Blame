import assert from "node:assert/strict";
import test from "node:test";
import { compilePreviewManifest } from "./manifest-compiler.js";

function manifest(production?: Record<string, unknown>) {
  return {
    confidence: "high",
    project: {},
    setup: [
      {
        id: "deps",
        container: { image: "node:24-bookworm" },
        command: "pnpm install",
      },
    ],
    services: [
      {
        id: "web",
        kind: "preview",
        container: { image: "node:24-bookworm" },
        command: "pnpm dev",
        environment: { NODE_ENV: "development", PORT: "3000" },
        endpoints: [
          {
            id: "http",
            protocol: "http",
            port: 3000,
            healthcheck: { type: "http", path: "/", timeoutMs: 30_000 },
          },
        ],
        ...(production ? { production } : {}),
      },
      {
        id: "db",
        kind: "dependency",
        container: { image: "postgres:17" },
        endpoints: [{ id: "sql", protocol: "tcp", port: 5432 }],
      },
    ],
    caches: [],
    risks: [],
    probes: [],
  };
}

const production = {
  build: "pnpm build",
  command: "pnpm start",
  environment: { NEXT_TELEMETRY_DISABLED: "1" },
};

test("the default plan ignores production commands, so its hash stays", () => {
  assert.deepEqual(
    compilePreviewManifest(manifest(production)),
    compilePreviewManifest(manifest()),
  );
});

test("the production plan serves the build of the services that declare one", () => {
  const plan = compilePreviewManifest(manifest(production), {
    serving: "production",
  });
  const web = plan.services.find(({ id }) => id === "web")!;
  assert.equal(plan.serving, "production");
  assert.equal(
    web.command,
    "(corepack enable 2>/dev/null || true) && corepack pnpm start",
  );
  assert.deepEqual(web.build, {
    command: "(corepack enable 2>/dev/null || true) && corepack pnpm build",
  });
  assert.deepEqual(web.environment, {
    NODE_ENV: "production",
    PORT: "3000",
    NEXT_TELEMETRY_DISABLED: "1",
  });
  const development = compilePreviewManifest(manifest(production));
  assert.deepEqual(plan.setup, development.setup);
  assert.deepEqual(
    plan.services.find(({ id }) => id === "db"),
    development.services.find(({ id }) => id === "db"),
  );
  assert.deepEqual(
    compilePreviewManifest(manifest(), { serving: "production" }).services,
    development.services,
  );
});

test("a production environment may keep its own NODE_ENV", () => {
  const plan = compilePreviewManifest(
    manifest({
      command: "node server.js",
      environment: { NODE_ENV: "staging" },
    }),
    { serving: "production" },
  );
  const web = plan.services.find(({ id }) => id === "web")!;
  assert.equal(web.environment.NODE_ENV, "staging");
  assert.equal(web.build, undefined);
});
