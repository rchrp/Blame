import assert from "node:assert/strict";
import test from "node:test";
import { parsePreviewManifest } from "./parser.js";

function manifest(): Record<string, any> {
  return {
    confidence: "high",
    project: { root: ".", detectedStack: ["node"] },
    setup: [
      {
        id: "deps",
        container: { image: "node:24-bookworm" },
        workingDir: "/workspace",
        command: "corepack pnpm install",
      },
    ],
    services: [
      {
        id: "api",
        kind: "worker",
        container: {
          build: { context: ".", dockerfile: "Dockerfile", target: "api" },
        },
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
        bindings: [
          {
            target: { type: "environment", key: "API_URL" },
            source: { service: "api", endpoint: "http" },
            exposure: "server",
          },
        ],
      },
      {
        id: "vitrine",
        kind: "preview",
        container: {
          image:
            "node:24-bookworm@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        command: "pnpm showcase",
        endpoints: [
          {
            id: "http",
            protocol: "http",
            port: 3001,
            healthcheck: { type: "http", path: "/", timeoutMs: 30_000 },
          },
        ],
      },
    ],
    probes: [
      {
        id: "api-through-app",
        from: "host",
        target: { service: "app", endpoint: "http", path: "/api/health" },
        type: "http",
        acceptedStatuses: [200, 401],
      },
    ],
    caches: [{ name: "pnpm", target: "/pnpm/store" }],
    risks: [],
  };
}

test("accepts only the canonical unversioned container manifest", () => {
  const parsed = parsePreviewManifest(manifest());
  assert.equal(parsed.services[0]?.container.build?.dockerfile, "Dockerfile");
  assert.equal(parsed.services[1]?.bindings?.[0]?.source.service, "api");
  assert.deepEqual(parsed.probes[0]?.acceptedStatuses, [200, 401]);
});

test("allows endpoint ids to repeat in different services", () => {
  const parsed = parsePreviewManifest(manifest());
  assert.deepEqual(
    parsed.services.map(({ id, endpoints }) => `${id}:${endpoints[0]?.id}`),
    ["api:http", "app:http", "vitrine:http"],
  );
});

test("rejects every field outside the canonical contract", () => {
  const versioned = manifest();
  versioned.version = 3;
  assert.throws(
    () => parsePreviewManifest(versioned),
    /unsupported field version/,
  );

  for (const kind of ["process", "auto"]) {
    const sourced = manifest();
    sourced.services[0].source = { kind };
    assert.throws(
      () => parsePreviewManifest(sourced),
      /unsupported field source/,
    );
  }
});

test("requires exactly one image or controlled build", () => {
  const both = manifest();
  both.services[0].container.image = "node:24";
  assert.throws(() => parsePreviewManifest(both), /exactly one/);

  const absolute = manifest();
  absolute.services[0].container = {
    build: { context: "/tmp/project", dockerfile: "Dockerfile" },
  };
  assert.throws(() => parsePreviewManifest(absolute), /inside the workspace/);

  const secretArgs = manifest();
  secretArgs.services[0].container.build.args = { API_TOKEN: "literal" };
  assert.throws(
    () => parsePreviewManifest(secretArgs),
    /unsupported field args/,
  );
});

test("rejects dangerous Compose topology escape hatches", () => {
  for (const [field, value] of [
    ["privileged", true],
    ["network_mode", "host"],
    ["pid", "host"],
    ["ipc", "host"],
    ["devices", ["/dev/kvm"]],
    ["cap_add", ["SYS_ADMIN"]],
    ["volumes", ["/var/run/docker.sock:/var/run/docker.sock"]],
  ] as const) {
    const unsafe = manifest();
    unsafe.services[0][field] = value;
    assert.throws(() => parsePreviewManifest(unsafe), /unsupported field/);
  }
});

test("rejects Docker socket commands", () => {
  const socket = manifest();
  socket.setup[0].command = "docker -H unix:///var/run/docker.sock info";
  assert.throws(() => parsePreviewManifest(socket), /command is unsafe/);
});

test("accepts development values under any key name", () => {
  const value = manifest();
  value.services[0].environment = {
    API_TOKEN: "literal",
    NEXTAUTH_SECRET: "dev",
    SESSION_KEY: "local-session",
  };
  value.setup[0].environment = {
    DATABASE_URL: "postgres://app:dev-password@database:5432/app",
    DB_PASSWORD: "dev-password",
    BROKER_URL: "amqp://guest:guest@rabbitmq:5672",
  };

  const parsed = parsePreviewManifest(value);
  assert.equal(parsed.services[0]?.environment?.NEXTAUTH_SECRET, "dev");
  assert.equal(parsed.setup[0]?.environment?.DB_PASSWORD, "dev-password");
});

test("rejects values that look like real credentials", () => {
  for (const [value, reason] of [
    ["-----BEGIN RSA PRIVATE KEY-----\nabc", /private key/],
    ["AKIAABCDEFGHIJKLMNOP", /AWS access key/],
    [`ghp_${"a".repeat(36)}`, /GitHub token/],
    [`sk_live_${"a".repeat(24)}`, /live Stripe key/],
    [`xoxb-${"1".repeat(20)}`, /Slack token/],
    ["mysql://app:secret@db.example.com:3306/app", /outside the preview/],
    ["https://user:pass@api.example.com/v1", /outside the preview/],
  ] as const) {
    const unsafe = manifest();
    unsafe.services[0].environment = { VALUE: value };
    assert.throws(() => parsePreviewManifest(unsafe), reason);
  }
});

test("rejects dependency cycles and invalid probes", () => {
  const cycle = manifest();
  cycle.services[0].dependsOn = ["app"];
  assert.throws(() => parsePreviewManifest(cycle), /must not contain cycles/);

  const status = manifest();
  status.probes[0].acceptedStatuses = [200, 502];
  assert.throws(
    () => parsePreviewManifest(status),
    /acceptedStatuses is invalid/,
  );
});

test("accepts projects without persistent services", () => {
  const value = manifest();
  value.services = [];
  value.probes = [];
  assert.deepEqual(parsePreviewManifest(value).services, []);
});
