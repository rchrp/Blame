import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { compilePreviewManifest } from "../compilation/manifest-compiler.js";
import type { ProbePlan, ServiceLaunchPlan } from "./execution-plan.js";
import {
  activeProbes,
  defaultProbeTimeoutMs,
  probeFailureMessage,
  probeStatusAccepted,
  serviceProbeCommand,
} from "./functional-probes.js";

test("accepts listed statuses, otherwise anything below 500", () => {
  assert.equal(probeStatusAccepted(200), true);
  assert.equal(probeStatusAccepted(302), true);
  assert.equal(probeStatusAccepted(404), true);
  assert.equal(probeStatusAccepted(500), false);
  assert.equal(probeStatusAccepted(404, [200]), false);
  assert.equal(probeStatusAccepted(503, [503]), true);
});

test("compiles probes with the shared defaults", () => {
  const plan = compilePreviewManifest({
    confidence: "high",
    project: {},
    setup: [],
    services: [
      {
        id: "web",
        kind: "preview",
        container: { image: "node:24" },
        command: "pnpm dev",
        endpoints: [
          {
            id: "http",
            protocol: "http",
            port: 3000,
            healthcheck: { type: "http", path: "/health", timeoutMs: 30000 },
          },
        ],
      },
    ],
    caches: [],
    risks: [],
    probes: [
      {
        id: "home",
        from: "host",
        type: "http",
        target: { service: "web", endpoint: "http" },
      },
    ],
  });
  assert.deepEqual(plan.probes[0], {
    id: "home",
    from: "host",
    target: { serviceId: "web", endpointId: "http", path: "/health" },
    type: "http",
    acceptedStatuses: [],
    timeoutMs: defaultProbeTimeoutMs,
    required: true,
  });
});

test("keeps only probes between selected services", () => {
  const plan = {
    probes: [
      probe({ id: "host", from: "host", serviceId: "web" }),
      probe({ id: "inner", from: "worker", serviceId: "api" }),
    ],
  };
  assert.deepEqual(
    activeProbes(plan, ["web", "api"]).map(({ id }) => id),
    ["host"],
  );
  assert.equal(activeProbes(plan).length, 2);
});

test("names the probe and its target when it fails", () => {
  assert.equal(
    probeFailureMessage(probe({ id: "home", path: "/login" }), "status 502"),
    "Required preview probe home failed on localhost:http/login: status 502",
  );
});

test("container probe scripts apply the shared status rule", async (t) => {
  const server = createServer((request, response) => {
    response.statusCode = Number(request.url?.slice(1));
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const runtimes = [
    { image: "node:24", executable: process.execPath },
    ...(spawnSync("python3", ["--version"]).status === 0
      ? [{ image: "python:3.13", executable: "python3" }]
      : []),
  ];
  for (const runtime of runtimes) {
    for (const accepted of [[], [200]]) {
      for (const status of [200, 404, 500]) {
        const item = probe({ path: `/${status}`, acceptedStatuses: accepted });
        const command = serviceProbeCommand(service(runtime.image), item, {
          id: "http",
          protocol: "http",
          port,
        });
        assert.ok(command);
        const result = await run(runtime.executable, command.slice(1));
        assert.equal(
          result === 0,
          probeStatusAccepted(status, accepted),
          `${runtime.image} status ${status} accepted ${JSON.stringify(accepted)}`,
        );
      }
    }
  }
});

function run(executable: string, args: string[]) {
  return new Promise<number | null>((resolve) => {
    spawn(executable, args, { stdio: "ignore" }).once("exit", resolve);
  });
}

function probe(input: {
  id?: string;
  from?: string;
  serviceId?: string;
  path?: string;
  acceptedStatuses?: number[];
}): ProbePlan {
  return {
    id: input.id ?? "probe",
    from: input.from ?? "host",
    target: {
      serviceId: input.serviceId ?? "localhost",
      endpointId: "http",
      path: input.path ?? "/",
    },
    type: "http",
    acceptedStatuses: input.acceptedStatuses ?? [],
    timeoutMs: 5_000,
    required: true,
  };
}

function service(image: string): ServiceLaunchPlan {
  return {
    id: "app",
    kind: "preview",
    container: { image },
    workingDir: "/workspace",
    environment: {},
    dependsOn: [],
    endpoints: [],
    bindings: [],
  };
}
