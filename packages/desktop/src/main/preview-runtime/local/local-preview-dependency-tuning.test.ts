import assert from "node:assert/strict";
import test from "node:test";
import { compilePreviewManifest } from "@blame/preview-runtime";
import type { DockerHost } from "@blame/preview-runtime/compose";
import { tunedDependencies } from "./local-preview-dependency-tuning.ts";

const plan = compilePreviewManifest({
  confidence: "high",
  project: {},
  setup: [],
  services: [
    {
      id: "web",
      kind: "preview",
      container: { image: "node:22" },
      command: "npm run dev",
      endpoints: [
        {
          id: "http",
          protocol: "http",
          port: 3000,
          healthcheck: { type: "http", path: "/", timeoutMs: 10_000 },
        },
      ],
    },
    {
      id: "mysql",
      kind: "dependency",
      container: { image: "mysql:8.4" },
      endpoints: [{ id: "sql", protocol: "tcp", port: 3306 }],
    },
    {
      id: "search",
      kind: "dependency",
      container: { image: "elasticsearch:8.17.0" },
      endpoints: [{ id: "http", protocol: "http", port: 9200 }],
    },
    {
      id: "cache",
      kind: "dependency",
      container: { image: "redis:7" },
      endpoints: [{ id: "redis", protocol: "tcp", port: 6379 }],
    },
  ],
  caches: [],
  risks: [],
  probes: [],
});

function host(
  stdout: string,
  exitCode = 0,
): DockerHost & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { exitCode, stdout, stderr: "" };
    },
    writeFile: async () => undefined,
    readFile: async () => undefined,
  } as unknown as DockerHost & { calls: string[][] };
}

test("tunes dependencies that have no container yet or already run tuned", async () => {
  assert.deepEqual(await tunedDependencies(host(""), "blame_x", plan), [
    "mysql",
    "search",
  ]);
  assert.deepEqual(
    await tunedDependencies(
      host("web\t\nmysql\t1\nsearch\t\n"),
      "blame_x",
      plan,
    ),
    ["mysql"],
  );
});

test("keeps the containers as they are when Docker cannot list them", async () => {
  assert.deepEqual(await tunedDependencies(host("", 1), "blame_x", plan), []);
});

test("asks Docker nothing for a plan without tunable dependencies", async () => {
  const docker = host("");
  const plain = {
    ...plan,
    services: plan.services.filter(({ id }) => id === "web"),
  };
  assert.deepEqual(await tunedDependencies(docker, "blame_x", plain), []);
  assert.equal(docker.calls.length, 0);
});
