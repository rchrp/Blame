import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PreviewExecutionPlan } from "../domain/execution-plan.js";
import { ComposeEngine, type EnginePhase } from "./compose-engine.js";
import { renderCompose } from "./compose-renderer.js";
import type { LocalComposeTarget } from "./compose-target.js";
import type { CommandResult, DockerHost } from "./docker-host.js";

// One Docker daemon with its volumes and the stamp directory of the Docker
// host, seen by the engines of several stories. A setup run fills the
// volumes; the steps of shared-setup.ts are modelled here (the scripts
// themselves run for real in shared-setup.test.ts).
class Daemon implements DockerHost {
  readonly commands: string[][] = [];
  readonly files = new Map<string, string>();
  readonly volumes = new Map<string, string>();
  /** What each volume holds. */
  readonly content = new Map<string, string>();
  /** The stamp files of the Docker host. */
  readonly stampFiles = new Map<string, string>();
  root = true;
  failInstall = false;
  /** A path the next setup runs write outside the volumes. */
  wrote: string | undefined;
  /** Holds the setup runs until it resolves. */
  gate: Promise<void> | undefined;
  databaseContainer = "db-1";

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.commands.push([command, ...args]);
    const script = command === "sh" ? args[1]! : "";
    if (script.startsWith("# shared-setup")) return this.sharedSetup(script);
    if (script.includes("docker inspect")) return ok("");
    if (script.includes("docker volume create"))
      return this.createVolumes(script);
    if (args.includes("ps") && args.includes("--quiet"))
      return ok(`${this.databaseContainer}\n`);
    if (args.includes("run")) {
      await this.gate;
      if (args.at(-1) === "setup-install") {
        if (this.failInstall) {
          this.content.set("blame_node_modules_abc123", "partial");
          return { exitCode: 1, stdout: "", stderr: "install failed" };
        }
        this.content.set("blame_node_modules_abc123", "installed");
      }
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

  probes() {
    return this.commands.filter((command) =>
      command[2]?.startsWith("# shared-setup"),
    ).length;
  }

  stamps() {
    return [...this.stampFiles.values()].filter(Boolean);
  }

  private createVolumes(script: string) {
    const names = [
      ...new Set(
        [...script.matchAll(/docker volume create .* '([^']+)'/g)].map(
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

  private sharedSetup(script: string): CommandResult {
    if (!this.root) return { exitCode: 3, stdout: "", stderr: "" };
    const step = /^# shared-setup (\w+)/.exec(script)![1];
    const stamp = /stamp='([^']+)'/.exec(script)![1]!;
    const fingerprint = /fp='([^']+)'/.exec(script)![1];
    const tracked = [
      ...script
        .slice(script.indexOf("sigs="))
        .matchAll(/docker volume inspect --format '[^']+' '([^']+)'/g),
    ].map(([, name]) => name!);
    const expected = [
      `fingerprint ${fingerprint}`,
      ...tracked.map(
        (name) =>
          `${name} ${createHash("sha256")
            .update(this.content.get(name) ?? "")
            .digest("hex")}`,
      ),
    ].join("\n");
    const valid = this.stampFiles.get(stamp) === expected;
    if (step === "probe") return ok(valid ? "valid" : "stale");
    if (step === "claim") {
      if (valid) return ok("valid");
      this.stampFiles.set(stamp, "");
      return ok("begun");
    }
    if (this.wrote) return ok(`wrote\t${this.wrote}`);
    this.stampFiles.set(stamp, expected);
    return ok("stamped");
  }
}

const owner = { uid: 1001, gid: 1001 };

function newStory(
  daemon: Daemon,
  name: string,
  extra: {
    measure?: <T>(phase: EnginePhase, action: () => Promise<T>) => Promise<T>;
    log?: string[];
    shared?: boolean;
  } = {},
) {
  const engine = new ComposeEngine({
    host: daemon,
    stateDirectory: `/state/${name}`,
    measure: extra.measure,
    log: extra.log ? (message) => extra.log!.push(message) : undefined,
    sharedSetup:
      extra.shared === false
        ? undefined
        : { directory: "/shared", workspace: `/worktrees/${name}` },
  });
  const prepare = () =>
    engine.prepare(renderCompose(plan(), target(name)), owner);
  return { engine, prepare };
}

const inputs = { current: "inputs-1" as string | undefined };
const lockfile = { current: "lock-1" };
const fingerprints = {
  lockfiles: async () => lockfile.current,
  sharedInstall: async () => inputs.current,
};

test.beforeEach(() => {
  inputs.current = "inputs-1";
  lockfile.current = "lock-1";
});

async function start(story: ReturnType<typeof newStory>, ids = ["web", "db"]) {
  await story.prepare();
  await story.engine.start(plan(), ids, fingerprints);
}

test("a new story skips an install another story ran on the same volume", async () => {
  const daemon = new Daemon();
  const log: string[] = [];
  await start(newStory(daemon, "story-a"));
  assert.deepEqual(daemon.composeRuns(), ["setup-install", "setup-migrate"]);
  assert.equal(daemon.stamps().length, 1);

  daemon.commands.length = 0;
  await start(newStory(daemon, "story-b", { log }));
  assert.deepEqual(
    daemon.composeRuns(),
    ["setup-migrate"],
    "the migration needs this story's database and runs",
  );
  assert.ok(log.join("").includes("Setup install is up to date (another"));

  // The skip is stamped in the story: a restart reads nothing else.
  daemon.commands.length = 0;
  await start(newStory(daemon, "story-b"));
  assert.equal(daemon.probes(), 0);
  assert.deepEqual(daemon.composeRuns(), []);
});

test("without a shared directory, stories keep their own stamps", async () => {
  const daemon = new Daemon();
  await start(newStory(daemon, "story-a", { shared: false }));
  daemon.commands.length = 0;
  await start(newStory(daemon, "story-b", { shared: false }));
  assert.deepEqual(daemon.composeRuns(), ["setup-install", "setup-migrate"]);
  assert.equal(daemon.probes(), 0);
  assert.equal(daemon.stamps().length, 0);
});

test("a task that waits for a service is never shared", async () => {
  const daemon = new Daemon();
  await start(newStory(daemon, "story-a"));
  daemon.commands.length = 0;
  await start(newStory(daemon, "story-b"));
  assert.ok(daemon.composeRuns().includes("setup-migrate"));
  assert.equal(daemon.stamps().length, 1);
});

test("a recreated volume runs the install again", async () => {
  const daemon = new Daemon();
  await start(newStory(daemon, "story-a"));
  daemon.volumes.set("blame_node_modules_abc123", "recreated");
  daemon.content.delete("blame_node_modules_abc123");
  daemon.commands.length = 0;
  await start(newStory(daemon, "story-b"));
  assert.ok(daemon.composeRuns().includes("setup-install"));
});

test("a volume changed since the stamp runs the install and is stamped again", async () => {
  const daemon = new Daemon();
  await start(newStory(daemon, "story-a"));
  // An agent ran `npm install left-pad` in a container of story A.
  daemon.content.set("blame_node_modules_abc123", "installed+left-pad");
  daemon.commands.length = 0;
  await start(newStory(daemon, "story-b"));
  assert.ok(daemon.composeRuns().includes("setup-install"), "repaired");
  daemon.commands.length = 0;
  await start(newStory(daemon, "story-c"));
  assert.ok(!daemon.composeRuns().includes("setup-install"));
});

test("a stamp for other dependencies or other inputs does not apply", async () => {
  const daemon = new Daemon();
  await start(newStory(daemon, "story-a"));
  inputs.current = "inputs-2"; // a nested lockfile or .npmrc changed
  daemon.commands.length = 0;
  await start(newStory(daemon, "story-b"));
  assert.ok(daemon.composeRuns().includes("setup-install"));
  inputs.current = "inputs-1";
  lockfile.current = "lock-2";
  daemon.commands.length = 0;
  await start(newStory(daemon, "story-c"));
  assert.ok(daemon.composeRuns().includes("setup-install"));
});

test("inputs that no hash covers keep the install in each story", async () => {
  const daemon = new Daemon();
  inputs.current = undefined; // postinstall scripts, file: dependencies
  await start(newStory(daemon, "story-a"));
  daemon.commands.length = 0;
  await start(newStory(daemon, "story-b"));
  assert.ok(daemon.composeRuns().includes("setup-install"));
  assert.equal(daemon.probes(), 0);
  assert.equal(daemon.stamps().length, 0);
});

test("a run that wrote in the worktree is not shared, and says so", async () => {
  const daemon = new Daemon();
  const log: string[] = [];
  daemon.wrote = "/worktrees/story-a/.nuxt";
  await start(newStory(daemon, "story-a", { log }));
  assert.equal(daemon.stamps().length, 0);
  assert.ok(log.join("").includes("Setup install also wrote .nuxt"));
  // Without a stamp, a rerun of the install is the rule, as before.
  daemon.commands.length = 0;
  await start(newStory(daemon, "story-b"));
  assert.ok(daemon.composeRuns().includes("setup-install"));
  // The story still keeps its own stamp.
  daemon.commands.length = 0;
  await start(newStory(daemon, "story-b"));
  assert.deepEqual(daemon.composeRuns(), []);
});

test("a failed install leaves no stamp and removes the previous one", async () => {
  const daemon = new Daemon();
  await start(newStory(daemon, "story-a"));
  assert.equal(daemon.stamps().length, 1);
  daemon.failInstall = true;
  lockfile.current = "lock-2"; // story B has another lockfile, same volume
  await assert.rejects(start(newStory(daemon, "story-b")), /install failed/);
  assert.equal(daemon.stamps().length, 0, "the old stamp no longer holds");
  daemon.failInstall = false;
  lockfile.current = "lock-1";
  daemon.commands.length = 0;
  await start(newStory(daemon, "story-c"));
  assert.ok(daemon.composeRuns().includes("setup-install"), "partial volume");
});

test("a host that cannot read the volumes shares nothing", async () => {
  const daemon = new Daemon();
  daemon.root = false;
  await start(newStory(daemon, "story-a"));
  assert.equal(daemon.stamps().length, 0);
  daemon.commands.length = 0;
  await start(newStory(daemon, "story-b"));
  assert.ok(daemon.composeRuns().includes("setup-install"));
});

test("a story that waited behind an identical install skips it once its turn comes", async () => {
  const daemon = new Daemon();
  let release!: () => void;
  daemon.gate = new Promise<void>((resolve) => (release = resolve));
  // The desktop runs installs one at a time.
  let tail: Promise<unknown> = Promise.resolve();
  let queued!: () => void;
  const waiting = new Promise<void>((resolve) => (queued = resolve));
  const queue = <T>(phase: EnginePhase, action: () => Promise<T>) => {
    if (phase !== "dependencies.install") return action();
    const turn = tail.then(action, action);
    tail = turn.catch(() => undefined);
    return turn;
  };
  const log: string[] = [];
  const a = start(newStory(daemon, "story-a", { measure: queue }));
  while (!daemon.composeRuns().includes("setup-install"))
    await new Promise((resolve) => setImmediate(resolve));
  // Story B reaches the queue while A installs: no stamp exists yet.
  const b = start(
    newStory(daemon, "story-b", {
      log,
      measure: (phase, action) => {
        if (phase === "dependencies.install") queued();
        return queue(phase, action);
      },
    }),
  );
  await waiting;
  release();
  await Promise.all([a, b]);
  assert.equal(
    daemon.composeRuns().filter((run) => run === "setup-install").length,
    1,
  );
  assert.ok(log.join("").includes("Setup install is up to date (another"));
});

test("a run in a volume only this story has is not shared", async () => {
  const daemon = new Daemon();
  daemon.wrote = "blame_storya_cache-postgres_data";
  await start(newStory(daemon, "story-a"));
  assert.equal(daemon.stamps().length, 0);
});

const node = { image: "node:24" };

function target(name: string): LocalComposeTarget {
  return {
    kind: "local",
    projectName: `blame_${name.replace("-", "")}`,
    workspacePath: `/worktrees/${name}`,
    projectUser: "1001:1001",
    hostPorts: { "web:http": 51000, "db:sql": 51001 },
    dependencyKey: "abc123",
  };
}

function plan(): PreviewExecutionPlan {
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
