import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import test from "node:test";
import type { ServiceLaunchPlan } from "../domain/execution-plan.js";
import type { ServiceState } from "./compose-engine.js";
import { endpointAnswers } from "./readiness.js";
import { waitForServices } from "./start-readiness.js";

const web = service("web", "node:24", {
  id: "http",
  protocol: "http",
  port: 3000,
  healthcheck: { type: "http", path: "/health", timeoutMs: 60_000 },
});
const worker = service("worker", "node:24");
const database = service("db", "postgres:17", {
  id: "sql",
  protocol: "tcp",
  port: 5432,
  healthcheck: { type: "tcp", timeoutMs: 60_000 },
});
const goServer = service("go", "golang:1.24", {
  id: "http",
  protocol: "http",
  port: 8080,
  healthcheck: { type: "http", path: "/", timeoutMs: 60_000 },
});
const targets = {
  "web:http": { host: "127.0.0.1" as const, port: 51000 },
  "db:sql": { host: "127.0.0.1" as const, port: 51001 },
  "go:http": { host: "127.0.0.1" as const, port: 51002 },
};

test("an HTTP service is ready when it answers, before Docker's health timer", async () => {
  const asked: string[] = [];
  let polls = 0;
  const result = await waitForServices({
    plan: { services: [web] },
    serviceIds: ["web"],
    targets,
    inspect: async () => [state("web", "running", "starting")],
    answers: async (target, path) => {
      asked.push(`${target.port}${path}`);
      return ++polls >= 3;
    },
    timeoutMs: 5_000,
  });
  assert.deepEqual(result, { outcome: "ready" });
  assert.deepEqual(asked, ["51000/health", "51000/health", "51000/health"]);
});

test("a service Docker finds healthy is ready even when it never answers from outside", async () => {
  // A server bound to the container's loopback: its own healthcheck passes,
  // the published port refuses.
  const result = await waitForServices({
    plan: { services: [web] },
    serviceIds: ["web"],
    targets,
    inspect: statesAfter(
      1,
      [state("web", "running", "healthy")],
      [state("web", "running", "starting")],
    ),
    answers: async () => false,
    timeoutMs: 5_000,
  });
  assert.deepEqual(result, { outcome: "ready" });
});

test("TCP endpoints, databases and runtimes without a scripted check are judged by Docker only", async () => {
  const asked: string[] = [];
  const result = await waitForServices({
    plan: { services: [database, goServer, worker] },
    serviceIds: ["db", "go", "worker"],
    targets,
    inspect: statesAfter(
      2,
      [
        state("db", "running", "healthy"),
        state("go", "running"),
        state("worker", "running"),
      ],
      [
        state("db", "running", "starting"),
        state("go", "created"),
        state("worker", "running"),
      ],
    ),
    answers: async (target) => {
      asked.push(String(target.port));
      return true;
    },
    timeoutMs: 5_000,
  });
  assert.deepEqual(result, { outcome: "ready" });
  assert.deepEqual(asked, [], "none of them is probed from outside");
});

test("a reply never makes a container that is not running ready", async () => {
  const result = await waitForServices({
    plan: { services: [web] },
    serviceIds: ["web"],
    targets,
    inspect: async () => [state("web", "created")],
    answers: async () => true,
    timeoutMs: 300,
  });
  assert.equal(result.outcome, "timeout");
});

test("a service that exits, dies or turns unhealthy fails the wait", async () => {
  for (const failed of [
    { ...state("web", "exited"), exitCode: 1 },
    { ...state("web", "exited"), exitCode: 0 },
    state("web", "dead"),
    state("web", "running", "unhealthy"),
  ]) {
    const result = await waitForServices({
      plan: { services: [web, worker] },
      serviceIds: ["web", "worker"],
      targets,
      inspect: async () => [failed, state("worker", "running")],
      answers: async () => false,
      timeoutMs: 5_000,
    });
    assert.deepEqual(result, { outcome: "failed", services: [failed] });
  }
});

test("a restarting container is still on its way, as for Compose", async () => {
  const result = await waitForServices({
    plan: { services: [web] },
    serviceIds: ["web"],
    targets,
    inspect: statesAfter(
      2,
      [state("web", "running", "healthy")],
      [state("web", "restarting")],
    ),
    answers: async () => false,
    timeoutMs: 5_000,
  });
  assert.deepEqual(result, { outcome: "ready" });
});

test("times out naming the services still waiting", async () => {
  const result = await waitForServices({
    plan: { services: [web, worker] },
    serviceIds: ["web", "worker"],
    targets,
    inspect: async () => [
      state("web", "running", "starting"),
      state("worker", "running"),
    ],
    answers: async () => false,
    timeoutMs: 400,
  });
  assert.deepEqual(result, {
    outcome: "timeout",
    services: [state("web", "running", "starting")],
  });
});

test("only the selected services are waited for", async () => {
  const result = await waitForServices({
    plan: { services: [web, database] },
    serviceIds: ["web"],
    targets,
    inspect: async () => [state("web", "running"), state("db", "exited")],
    answers: async () => false,
    timeoutMs: 5_000,
  });
  assert.deepEqual(result, { outcome: "ready" });
});

test("a port forwarder that accepts connections before the app listens is not an answer", async () => {
  const forwarder = net.createServer((socket) => socket.destroy());
  forwarder.listen(0, "127.0.0.1");
  await once(forwarder, "listening");
  const port = (forwarder.address() as net.AddressInfo).port;
  try {
    const result = await waitForServices({
      plan: { services: [web] },
      serviceIds: ["web"],
      targets: { "web:http": { host: "127.0.0.1", port } },
      inspect: async () => [state("web", "running", "starting")],
      answers: endpointAnswers,
      timeoutMs: 600,
    });
    assert.equal(result.outcome, "timeout");
  } finally {
    forwarder.close();
  }
});

test("a real server answering below 500 is ready, one answering 503 is not", async () => {
  let status = 503;
  const server = createServer((_request, response) => {
    response.statusCode = status;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  const wait = () =>
    waitForServices({
      plan: { services: [web] },
      serviceIds: ["web"],
      targets: { "web:http": { host: "127.0.0.1", port } },
      inspect: async () => [state("web", "running", "starting")],
      answers: endpointAnswers,
      timeoutMs: 500,
    });
  try {
    assert.equal((await wait()).outcome, "timeout");
    status = 404;
    assert.equal((await wait()).outcome, "ready");
  } finally {
    server.close();
  }
});

// States as `inspect` reads them, the first `count` reads showing `before`.
function statesAfter(
  count: number,
  after: ServiceState[],
  before: ServiceState[],
) {
  let reads = 0;
  return async () => (reads++ < count ? before : after);
}

function state(id: string, status: string, health?: string): ServiceState {
  return {
    id,
    running: status === "running",
    healthy: health ? health === "healthy" : undefined,
    health,
    state: status,
  };
}

function service(
  id: string,
  image: string,
  endpoint?: ServiceLaunchPlan["endpoints"][number],
): ServiceLaunchPlan {
  return {
    id,
    kind: id === "db" ? "dependency" : "preview",
    container: { image },
    workingDir: "/workspace",
    command: image.startsWith("node") ? "node server.js" : undefined,
    environment: {},
    dependsOn: [],
    endpoints: endpoint ? [endpoint] : [],
    bindings: [],
  };
}
