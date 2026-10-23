import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { PreviewExecutionPlan, ProbePlan } from "@blame/preview-runtime";
import { runFunctionalProbes } from "./functional-probes.js";

test("passes host probes with the shared status rule", async (t) => {
  const port = await statusServer(t);
  const results = await runFunctionalProbes({
    plan: plan([
      probe({ id: "redirect", path: "/302" }),
      probe({ id: "missing", path: "/404" }),
    ]),
    serviceIds: ["web"],
    targets: { "web:http": { host: "127.0.0.1", port } },
    exec: unexpectedExec,
  });
  assert.deepEqual(results, [
    { id: "redirect", passed: true },
    { id: "missing", passed: true },
  ]);
});

test("fails the start on a required probe with its target", async (t) => {
  const port = await statusServer(t);
  await assert.rejects(
    runFunctionalProbes({
      plan: plan([probe({ id: "home", path: "/500" })]),
      serviceIds: ["web"],
      targets: { "web:http": { host: "127.0.0.1", port } },
      exec: unexpectedExec,
    }),
    (error: Error & { runnerCode?: string }) =>
      error.runnerCode === "FUNCTIONAL_PROBE_FAILED" &&
      error.message ===
        "Required preview probe home failed on web:http/500: status 500",
  );
});

test("records an optional probe failure without failing", async (t) => {
  const port = await statusServer(t);
  const results = await runFunctionalProbes({
    plan: plan([
      probe({ id: "strict", path: "/404", acceptedStatuses: [200] }),
    ]).withOptional(),
    serviceIds: ["web"],
    targets: { "web:http": { host: "127.0.0.1", port } },
    exec: unexpectedExec,
  });
  assert.deepEqual(results, [{ id: "strict", passed: false }]);
});

test("runs service probes inside the origin container", async () => {
  const calls: Array<{ serviceId: string; command: string[] }> = [];
  const results = await runFunctionalProbes({
    plan: plan([probe({ id: "inner", from: "web", path: "/api" })]),
    serviceIds: ["web"],
    targets: {},
    exec: async (serviceId, command) => {
      calls.push({ serviceId, command });
      return { exitCode: 0 };
    },
  });
  assert.deepEqual(results, [{ id: "inner", passed: true }]);
  assert.equal(calls[0]?.serviceId, "web");
  assert.equal(calls[0]?.command[0], "node");
  assert.match(calls[0]?.command[2] ?? "", /http:\/\/web:3000\/api/);
});

test("skips probes of services that are not selected", async () => {
  const results = await runFunctionalProbes({
    plan: plan([probe({ id: "home" })]),
    serviceIds: [],
    targets: {},
    exec: unexpectedExec,
  });
  assert.deepEqual(results, []);
});

async function statusServer(t: { after: (fn: () => void) => void }) {
  const server = createServer((request, response) => {
    response.statusCode = Number(request.url?.slice(1));
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}

async function unexpectedExec(): Promise<{ exitCode: number }> {
  throw new Error("exec should not run for host probes");
}

function probe(input: {
  id: string;
  from?: string;
  path?: string;
  acceptedStatuses?: number[];
}): ProbePlan {
  return {
    id: input.id,
    from: input.from ?? "host",
    target: { serviceId: "web", endpointId: "http", path: input.path ?? "/" },
    type: "http",
    acceptedStatuses: input.acceptedStatuses ?? [],
    timeoutMs: 5_000,
    required: true,
  };
}

function plan(probes: ProbePlan[]) {
  const value = {
    version: 2,
    workspaceRoot: "/workspace",
    setup: [],
    services: [
      {
        id: "web",
        kind: "preview",
        container: { image: "node:24" },
        workingDir: "/workspace",
        command: "pnpm dev",
        environment: {},
        dependsOn: [],
        endpoints: [{ id: "http", protocol: "http", port: 3000 }],
        bindings: [],
      },
    ],
    caches: [],
    probes,
    environmentPlan: { entries: [], cleanupRequired: true },
    networking: {
      gatewayListeners: [],
      loopbackGroups: [],
      publishedPortCount: 0,
      browserBindingCount: 0,
      requiresSharedLoopback: false,
      requiresWebSockets: false,
      integratedPreviewRequired: false,
      incompatibilityReasons: [],
    },
    detectedCompatibility: [],
  } satisfies PreviewExecutionPlan;
  return Object.assign(value, {
    withOptional: () => ({
      ...value,
      probes: probes.map((item) => ({ ...item, required: false })),
    }),
  });
}
