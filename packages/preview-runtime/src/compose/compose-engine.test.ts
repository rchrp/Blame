import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewExecutionPlan } from "../domain/execution-plan.js";
import { ComposeEngine } from "./compose-engine.js";
import { renderCompose } from "./compose-renderer.js";
import type { LocalComposeTarget } from "./compose-target.js";
import type { CommandResult, DockerHost } from "./docker-host.js";

// A Docker host that records commands and keeps files in memory. Volumes
// live in one shared map, like the volumes of one Docker daemon.
class FakeHost implements DockerHost {
  readonly commands: string[][] = [];
  readonly files = new Map<string, string>();
  readonly volumes = new Map<string, string>();
  databaseContainer = "db-1";
  containers: string[] = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.commands.push([command, ...args]);
    if (command === "sh" && args[1]!.includes("docker inspect")) {
      return ok(this.containers.join("\n"));
    }
    if (command === "sh") {
      const names = [
        ...new Set(
          [...args[1]!.matchAll(/docker volume create .* '([^']+)'/g)].map(
            (match) => match[1]!,
          ),
        ),
      ];
      return ok(
        names
          .map((name) => {
            if (!this.volumes.has(name))
              this.volumes.set(name, `created-${this.volumes.size}`);
            return `${name}\t${this.volumes.get(name)}\n`;
          })
          .join(""),
      );
    }
    if (args.includes("ps") && args.includes("--quiet")) {
      return ok(`${this.databaseContainer}\n`);
    }
    return ok("");
  }

  async readFile(path: string) {
    return this.files.get(path);
  }

  async writeFile(path: string, content: string) {
    this.files.set(path, content);
  }

  composeRuns() {
    return this.commands
      .filter((command) => command.includes("run"))
      .map((command) => command.at(-1));
  }
}

test("writes the Compose file once and prepares owned volumes", async () => {
  const host = new FakeHost();
  const engine = engineFor(host, "story-a");
  const rendered = renderCompose(plan(), target("story-a"));
  assert.deepEqual(await engine.prepare(rendered, owner), { changed: true });
  assert.deepEqual(await engine.prepare(rendered, owner), { changed: false });
  const volumeScript = host.commands.find(([command]) => command === "sh")!;
  assert.match(volumeScript[2]!, /chown 1001:1001 "\$\(docker volume inspect/);
  assert.match(volumeScript[2]!, /blame_node_modules_abc123/);
  assert.equal(host.files.get("/state/story-a/compose.yaml"), rendered.yaml);
});

test("reruns the install when its node_modules volume is recreated", async () => {
  const host = new FakeHost();
  const engine = engineFor(host, "story-a");
  const rendered = renderCompose(plan(), target("story-a"));
  await engine.prepare(rendered, owner);
  await engine.start(plan(), ["web", "db"], fingerprints);
  host.volumes.set("blame_node_modules_abc123", "recreated");
  await engine.prepare(rendered, owner);
  host.commands.length = 0;
  await engine.start(plan(), ["web", "db"], fingerprints);
  assert.deepEqual(host.composeRuns(), ["setup-install", "setup-migrate"]);
});

test("starts services with Docker waiting for health", async () => {
  const host = new FakeHost();
  const engine = engineFor(host, "story-a");
  await engine.prepare(renderCompose(plan(), target("story-a")), owner);
  await engine.start(plan(), ["web", "db"], fingerprints);
  const up = [...host.commands]
    .reverse()
    .find((command) => command.includes("up"))!;
  assert.deepEqual(up.slice(up.indexOf("up")), [
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "600",
    "--remove-orphans",
    "--no-build",
    "web",
    "db",
  ]);
  assert.deepEqual(host.composeRuns(), ["setup-install", "setup-migrate"]);
});

test("reruns a setup task when its dependency is recreated", async () => {
  const host = new FakeHost();
  const engine = engineFor(host, "story-a");
  await engine.prepare(renderCompose(plan(), target("story-a")), owner);
  await engine.start(plan(), ["web", "db"], fingerprints);
  host.commands.length = 0;
  await engine.start(plan(), ["web", "db"], fingerprints);
  assert.deepEqual(host.composeRuns(), []);
  host.databaseContainer = "db-2";
  await engine.start(plan(), ["web", "db"], fingerprints);
  assert.deepEqual(host.composeRuns(), ["setup-migrate"]);
});

test("prefetch pulls every image and installs without starting a service", async () => {
  const host = new FakeHost();
  const engine = engineFor(host, "story-a");
  await engine.prepare(renderCompose(plan(), target("story-a")), owner);
  await engine.prefetch(plan(), fingerprints);
  const pull = host.commands.find((command) => command.includes("pull"))!;
  assert.deepEqual(pull.slice(pull.indexOf("--ignore-buildable") + 1).sort(), [
    "db",
    "setup-install",
    "setup-migrate",
    "web",
  ]);
  assert.deepEqual(host.composeRuns(), ["setup-install"]);
  assert.ok(!host.commands.some((command) => command.includes("up")));
  host.commands.length = 0;
  await engine.start(plan(), ["web", "db"], fingerprints);
  assert.deepEqual(host.composeRuns(), ["setup-migrate"], "install is done");
});

test("stops without removing containers unless asked", async () => {
  const host = new FakeHost();
  const engine = engineFor(host, "story-a");
  await engine.stop();
  assert.equal(host.commands.length, 0, "nothing to stop before prepare");
  await engine.prepare(renderCompose(plan(), target("story-a")), owner);
  await engine.stop();
  await engine.stop({ remove: true });
  const [stop, down] = host.commands.slice(-2);
  assert.ok(stop!.includes("stop"));
  assert.ok(down!.includes("down"));
});

const owner = { uid: 1001, gid: 1001 };
const fingerprints = { lockfiles: async () => "lock-1" };

function engineFor(host: DockerHost, story: string) {
  return new ComposeEngine({ host, stateDirectory: `/state/${story}` });
}

function target(story: string): LocalComposeTarget {
  return {
    kind: "local",
    projectName: `blame_${story.replace("-", "")}`,
    workspacePath: `/worktrees/${story}`,
    projectUser: "1001:1001",
    hostPorts: { "web:http": 51000, "db:sql": 51001 },
    dependencyKey: "abc123",
  };
}

function plan(): PreviewExecutionPlan {
  const node = { image: "node:24" };
  return {
    version: 2,
    workspaceRoot: "/workspace",
    setup: [
      {
        id: "install",
        container: node,
        workingDir: "/workspace",
        command: "corepack pnpm install",
        runAs: "host",
        environment: {},
        dependsOn: [],
      },
      {
        id: "migrate",
        container: node,
        workingDir: "/workspace",
        command: "corepack pnpm prisma migrate deploy",
        runAs: "host",
        environment: {},
        dependsOn: ["install", "db"],
      },
    ],
    services: [
      {
        id: "web",
        kind: "preview",
        container: node,
        workingDir: "/workspace",
        command: "corepack pnpm dev",
        environment: {},
        dependsOn: ["db"],
        endpoints: [{ id: "http", protocol: "http", port: 3000 }],
        bindings: [],
      },
      {
        id: "db",
        kind: "dependency",
        container: { image: "postgres:17" },
        workingDir: "/workspace",
        environment: {},
        dependsOn: [],
        endpoints: [{ id: "sql", protocol: "tcp", port: 5432 }],
        bindings: [],
      },
    ],
    caches: [
      { name: "blame_node_modules", target: "/workspace/node_modules" },
      { name: "postgres_data", target: "/var/lib/postgresql/data" },
    ],
    probes: [],
    environmentPlan: { cleanupRequired: true, entries: [] },
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
  };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

test("reads service states from the Docker Engine, without one-off containers", async () => {
  const host = new FakeHost();
  const engine = engineFor(host, "story-a");
  await engine.prepare(renderCompose(plan(), target("story-a")), owner);
  host.containers = [
    "web\tFalse\texited\t143\t",
    "web\tFalse\trunning\t0\thealthy",
    "db\tTrue\trunning\t0\t",
    "db\tFalse\texited\t1\tunhealthy",
  ];
  const states = await engine.inspect({
    services: [{ id: "web" }, { id: "db" }, { id: "worker" }],
  } as PreviewExecutionPlan);
  assert.deepEqual(states, [
    {
      id: "web",
      running: true,
      healthy: true,
      health: "healthy",
      state: "running",
      exitCode: 0,
    },
    {
      id: "db",
      running: false,
      healthy: false,
      health: "unhealthy",
      state: "exited",
      exitCode: 1,
    },
    {
      id: "worker",
      running: false,
      healthy: undefined,
      health: undefined,
      state: undefined,
      exitCode: undefined,
    },
  ]);
  const query = host.commands.at(-1)!;
  assert.equal(query.at(-1), "blame_storya");
});
