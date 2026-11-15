import assert from "node:assert/strict";
import test from "node:test";
import { parsePreviewManifest } from "./parser.js";

function manifest(service: Record<string, unknown>) {
  return {
    confidence: "high",
    project: {},
    setup: [],
    services: [
      {
        id: "web",
        kind: "preview",
        container: { image: "node:24-bookworm" },
        command: "pnpm dev",
        endpoints: [
          {
            id: "http",
            protocol: "http",
            port: 3000,
            healthcheck: { type: "http", path: "/", timeoutMs: 30_000 },
          },
        ],
        ...service,
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

test("keeps a service's production build and serve commands", () => {
  const parsed = parsePreviewManifest(
    manifest({
      production: {
        build: "pnpm build",
        command: "pnpm start",
        environment: { NEXT_TELEMETRY_DISABLED: "1" },
      },
    }),
  );
  assert.deepEqual(parsed.services[0]!.production, {
    build: "pnpm build",
    command: "pnpm start",
    environment: { NEXT_TELEMETRY_DISABLED: "1" },
  });
  assert.equal(parsed.services[1]!.production, undefined);
  assert.deepEqual(
    parsePreviewManifest(
      manifest({ production: { command: "node dist/server.js" } }),
    ).services[0]!.production,
    { command: "node dist/server.js" },
  );
});

test("refuses incomplete, unsafe or misplaced production commands", () => {
  const invalid: Array<[Record<string, unknown>, RegExp]> = [
    [{ production: { build: "pnpm build" } }, /production.command is required/],
    [{ production: { command: " " } }, /production.command is required/],
    [
      { production: { command: "pnpm start", watch: true } },
      /unsupported field watch/,
    ],
    [{ production: { command: "sudo pnpm start" } }, /command is unsafe/],
    [
      {
        production: {
          command: "pnpm start",
          environment: { "BAD-KEY": "1" },
        },
      },
      /production.environment is invalid/,
    ],
    [
      { production: { command: "pnpm start" }, surface: { type: "terminal" } },
      /only for web surfaces/,
    ],
  ];
  for (const [service, message] of invalid)
    assert.throws(() => parsePreviewManifest(manifest(service)), message);
  const dependency = manifest({});
  dependency.services[1] = {
    ...dependency.services[1]!,
    production: { command: "postgres" },
  } as never;
  assert.throws(
    () => parsePreviewManifest(dependency),
    /production needs a project service with a command/,
  );
});
