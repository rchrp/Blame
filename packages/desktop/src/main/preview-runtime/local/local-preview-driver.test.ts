import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectPreviewRuntimeState } from "@blame/agent-runtime";
import {
  LocalPreviewDriver,
  type LocalRuntimeAdapter,
} from "./local-preview-driver.ts";

test("drives the local Compose project through the provider-neutral driver contract", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "blame-local-driver-"));
  let running = false;
  const runtime = (): ProjectPreviewRuntimeState => ({
    configurations: [
      {
        id: "web",
        name: "Web",
        command: "dev",
        cwd: ".",
        default: true,
        previewService: "web",
      },
    ],
    desiredStatus: running ? "running" : "stopped",
    previewUrl: running ? "http://127.0.0.1:3000" : undefined,
    selectedConfigurationId: "web",
    statuses: { web: running ? "running" : "stopped" },
  });
  const adapter: LocalRuntimeAdapter = {
    async control(input) {
      running = input.action !== "stop";
      return runtime();
    },
    async state() {
      return runtime();
    },
    async services() {
      return [{ id: "web", running, healthy: running }];
    },
    async endpoints() {
      return {
        routes: [
          {
            serviceId: "web",
            endpointId: "http",
            protocol: "http" as const,
            port: 3000,
          },
        ],
        primary: undefined,
      };
    },
    async logs() {
      return { stdout: "ready", stderr: "" };
    },
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  try {
    const driver = new LocalPreviewDriver(async () => worktree, adapter);
    const { handle } = await driver.provisionHost({
      sessionId: "session-local",
      userStoryId: "story-local",
      generation: 1,
      fencingToken: 1,
      plan: plan(),
      resourceSize: { vcpus: 2, memoryGb: 4 },
    });
    await driver.startServices(handle, { configurationId: "web" });
    assert.equal((await driver.inspect(handle)).engine, "running");
    assert.equal((await driver.endpoints(handle)).routes[0]?.logicalPort, 3000);
    const logs = [];
    for await (const event of driver.logs({ handle })) logs.push(event.message);
    assert.deepEqual(logs, ["ready"]);
    await driver.stopServices(handle);
    assert.equal((await driver.inspect(handle)).engine, "stopped");
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test("connects VM-internal worktrees without resolving them on the desktop host", async () => {
  const worktree =
    "/home/blame/.local/share/blame/runtime/worktrees/Blame/story-US-174-say-hello";
  const observedWorktrees: string[] = [];
  const runtime = (): ProjectPreviewRuntimeState => ({
    configurations: [
      {
        id: "web",
        name: "Web",
        command: "dev",
        cwd: ".",
        default: true,
        previewService: "web",
      },
    ],
    desiredStatus: "stopped",
    selectedConfigurationId: "web",
    statuses: { web: "stopped" },
  });
  const adapter: LocalRuntimeAdapter = {
    async control(input) {
      observedWorktrees.push(input.worktree);
      return runtime();
    },
    async state(input) {
      observedWorktrees.push(input);
      return runtime();
    },
    async services() {
      return [];
    },
    async endpoints() {
      return { routes: [], primary: undefined };
    },
    async logs() {
      return undefined;
    },
    async exec(cwd) {
      observedWorktrees.push(cwd);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const driver = new LocalPreviewDriver(async () => worktree, adapter);
  const handle = await driver.connect(`${worktree}/`);
  await driver.runtimeState(handle);
  await driver.startServices(handle, { configurationId: "web" });
  await driver.exec(handle, { command: "ls", cwd: "/workspace/apps/web" });

  assert.deepEqual(observedWorktrees, [
    worktree,
    worktree,
    `${worktree}/apps/web`,
  ]);
});

function plan() {
  return {
    version: 2 as const,
    workspaceRoot: "/workspace" as const,
    setup: [],
    caches: [],
    probes: [],
    detectedCompatibility: [],
    environmentPlan: { cleanupRequired: true as const, entries: [] },
    services: [
      {
        id: "web",
        kind: "preview" as const,
        container: { image: "node:24" },
        workingDir: "/workspace",
        environment: {},
        dependsOn: [],
        bindings: [],
        endpoints: [{ id: "http", protocol: "http" as const, port: 3000 }],
      },
    ],
    networking: {
      gatewayListeners: [
        {
          routeKey: "web:http",
          serviceId: "web",
          endpointId: "http",
          logicalPort: 3000,
          sandboxPort: 43000,
          targetHost: "web",
          targetPort: 3000,
          basePathMode: "root" as const,
        },
      ],
      loopbackGroups: [],
      publishedPortCount: 1,
      browserBindingCount: 0,
      requiresSharedLoopback: false,
      requiresWebSockets: true,
      integratedPreviewRequired: false,
      incompatibilityReasons: [],
    },
  };
}
