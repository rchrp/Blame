import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parsePreviewManifest } from "@blame/agent-runtime/preview-manifest";
import { compilePreviewManifest } from "@blame/preview-runtime";
import type { CommandResult, DockerHost } from "@blame/preview-runtime/compose";
import { allocatePreviewHostPorts } from "./local-preview-ports.ts";
import { useLocalDockerHost } from "./local-preview-runner.ts";
import {
  buildKeys,
  readServingState,
  requestDevelopmentServing,
  resetServingActivity,
  reviewBuild,
  sourceRevision,
  startLocalPreviewServing,
  useReviewBuildSetting,
  useServingAgentCheck,
} from "./local-preview-serving.ts";
import { PreviewServingSettings } from "../preview-serving-settings.ts";

const manifest = parsePreviewManifest({
  confidence: "high",
  project: {},
  setup: [],
  services: [
    {
      id: "web",
      kind: "preview",
      container: { image: "node:22-bookworm-slim" },
      command: "npx next dev -H 0.0.0.0 -p 3000",
      endpoints: [
        {
          id: "http",
          protocol: "http",
          port: 3000,
          healthcheck: { type: "http", path: "/", timeoutMs: 10_000 },
        },
      ],
      production: {
        build: "npx next build",
        command: "npx next start -H 0.0.0.0 -p 3000",
      },
    },
  ],
  caches: [],
  risks: [],
  probes: [],
});

const runConfigurations = [
  {
    id: "web",
    name: "Web",
    command: "npm run dev",
    cwd: ".",
    default: true,
    category: "web",
    services: ["web"],
    previewService: "web",
    scopes: ["."],
  },
];

class FakeDockerHost implements DockerHost {
  readonly commands: string[][] = [];
  buildExitCode = 0;
  paused = false;

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.commands.push([command, ...args]);
    if (command === "sh" && args[1]!.includes("docker inspect"))
      return ok(
        `web\t${this.paused ? "True" : "False"}\t${this.paused ? "paused" : "running"}\t0\thealthy`,
      );
    if (command === "sh") {
      const names = [
        ...args[1]!.matchAll(/docker volume create .* '([^']+)'/g),
      ].map((match) => match[1]!);
      return ok(names.map((name) => `${name}\tcreated\n`).join(""));
    }
    if (args.includes("run") && args.includes("--no-deps"))
      return { exitCode: this.buildExitCode, stdout: "", stderr: "" };
    return ok("");
  }

  async readFile(path: string) {
    return readFile(path, "utf8").catch(() => undefined);
  }

  async writeFile(path: string, content: string) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }

  builds() {
    return this.commands.filter(
      (command) => command.includes("run") && command.includes("--no-deps"),
    );
  }
}

test("builds a story in review next to its development server, then serves the build", async (t) => {
  const { worktree, host, restarts, logs } = await fixture(t);
  const now = Date.now();

  assert.equal(
    await reviewBuild(worktree, dependencies(restarts, logs), now),
    "production",
  );
  const [build] = host.builds();
  assert.ok(build, "one build ran");
  assert.deepEqual(build.slice(-4), [
    "web",
    "/bin/sh",
    "-lc",
    "npx next build",
  ]);
  assert.ok(
    build.join(" ").includes("/.blame/preview/review-build/compose.yaml"),
  );
  assert.deepEqual(restarts, [worktree]);
  const state = await readServingState(worktree);
  assert.equal(state.mode, "development");
  assert.ok(state.builds.web);

  // The restart the sweeper asked for serves the build.
  await startLocalPreviewServing(worktree);
  const compose = await readFile(
    join(worktree, ".blame/preview/compose.yaml"),
    "utf8",
  );
  assert.match(compose, /npx next start -H 0\.0\.0\.0 -p 3000/);
  const serving = await readServingState(worktree);
  assert.equal(serving.mode, "production");
  assert.equal(serving.revision, await sourceRevision(worktree));

  // Nothing to do while the source stays the same.
  restarts.length = 0;
  assert.equal(
    await reviewBuild(worktree, dependencies(restarts, logs), Date.now()),
    "production",
  );
  assert.deepEqual(restarts, []);
  assert.equal(host.builds().length, 1);

  // An edit goes back to the development server, then builds again.
  await writeFile(join(worktree, "page.tsx"), "export default 2\n");
  assert.equal(
    await reviewBuild(worktree, dependencies(restarts, logs), Date.now()),
    "development",
  );
  assert.deepEqual(restarts, [worktree]);
  await startLocalPreviewServing(worktree);
  assert.match(
    await readFile(join(worktree, ".blame/preview/compose.yaml"), "utf8"),
    /npx next dev -H 0\.0\.0\.0 -p 3000/,
  );
  assert.equal((await readServingState(worktree)).mode, "development");
});

test("keeps the development server when a build fails, and does not retry that revision", async (t) => {
  const { worktree, host, restarts, logs } = await fixture(t);
  host.buildExitCode = 1;
  assert.equal(
    await reviewBuild(worktree, dependencies(restarts, logs), Date.now()),
    "development",
  );
  assert.deepEqual(restarts, []);
  assert.ok(
    host.commands.some((command) => command.includes("restart")),
    "the development service restarts after a failed build",
  );
  const state = await readServingState(worktree);
  assert.equal(state.failed, await sourceRevision(worktree));
  assert.ok(logs.join("").includes("review build of web failed"));
  assert.equal(
    await reviewBuild(worktree, dependencies(restarts, logs), Date.now()),
    "development",
  );
  assert.equal(host.builds().length, 1);
});

test("an agent at work, a paused preview or a disabled project keeps the development server", async (t) => {
  const { worktree, host, restarts, logs } = await fixture(t);
  useServingAgentCheck(() => true);
  assert.equal(
    await reviewBuild(worktree, dependencies(restarts, logs), Date.now()),
    "development",
  );
  useServingAgentCheck(() => false);
  // Within the grace period after the agent's last turn.
  await requestDevelopmentServing(worktree);
  assert.equal(
    await reviewBuild(worktree, dependencies(restarts, logs), Date.now()),
    "development",
  );
  resetServingActivity();
  host.paused = true;
  assert.equal(
    await reviewBuild(worktree, dependencies(restarts, logs), Date.now()),
    "development",
  );
  host.paused = false;
  useReviewBuildSetting(async () => false);
  assert.equal(
    await reviewBuild(worktree, dependencies(restarts, logs), Date.now()),
    "development",
  );
  assert.equal(host.builds().length, 0);
  assert.deepEqual(restarts, []);
});

test("a build key changes with the revision, the environment and the build command", () => {
  const plan = compilePreviewManifest(manifest, { serving: "production" });
  const yaml = (value: string) =>
    `services:\n  web:\n    image: node:22\n    environment:\n      PUBLIC_URL: "${value}"\n`;
  const key = buildKeys({ plan }, yaml("a"), ["web"], "r1").web;
  assert.equal(buildKeys({ plan }, yaml("a"), ["web"], "r1").web, key);
  assert.notEqual(buildKeys({ plan }, yaml("b"), ["web"], "r1").web, key);
  assert.notEqual(buildKeys({ plan }, yaml("a"), ["web"], "r2").web, key);
  const other = structuredClone(plan);
  other.services[0]!.build = { command: "npx next build --debug" };
  assert.notEqual(
    buildKeys({ plan: other }, yaml("a"), ["web"], "r1").web,
    key,
  );
});

test("review builds are on unless a project turns them off", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "blame-serving-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "settings.json");
  const settings = new PreviewServingSettings(file);
  assert.equal(await settings.reviewBuilds("/work/shop"), true);
  await settings.setReviewBuilds("/work/shop/", false);
  assert.equal(await settings.reviewBuilds("/work/shop"), false);
  assert.equal(
    await new PreviewServingSettings(file).reviewBuilds("/work/shop"),
    false,
  );
  assert.equal(await settings.reviewBuilds("/work/blog"), true);
  await settings.setReviewBuilds("/work/shop", true);
  assert.equal(
    await new PreviewServingSettings(file).reviewBuilds("/work/shop"),
    true,
  );
});

function dependencies(restarts: string[], logs: string[]) {
  return {
    runningWorktrees: async () => [],
    restart: async (worktree: string) => {
      restarts.push(worktree);
    },
    log: (_worktree: string, chunk: string) => {
      logs.push(chunk);
    },
  };
}

async function fixture(t: { after: (fn: () => Promise<void> | void) => void }) {
  const worktree = await mkdtemp(join(tmpdir(), "blame-serving-"));
  t.after(() => rm(worktree, { recursive: true, force: true }));
  const directory = join(worktree, ".blame/initialization");
  await mkdir(directory, { recursive: true });
  await writeFile(join(worktree, "package.json"), '{"name":"fixture"}\n');
  await writeFile(join(worktree, "page.tsx"), "export default 1\n");
  await writeFile(
    join(directory, "preview-manifest.json"),
    JSON.stringify(manifest),
  );
  await writeFile(
    join(directory, "run-configurations.json"),
    JSON.stringify(runConfigurations),
  );
  await writeFile(
    join(directory, "preview-runtime-state.json"),
    JSON.stringify({
      desiredStatus: "running",
      selectedConfigurationId: "web",
    }),
  );
  const git = promisify(execFile);
  await git("git", ["init", "-q"], { cwd: worktree });
  await writeFile(join(worktree, ".gitignore"), ".blame/\n");
  const host = new FakeDockerHost();
  useLocalDockerHost(host);
  useServingAgentCheck(() => false);
  useReviewBuildSetting(async () => true);
  resetServingActivity();
  const ports = await allocatePreviewHostPorts(
    worktree,
    compilePreviewManifest(manifest),
  );
  // The containers already publish these ports.
  await mkdir(join(worktree, ".blame/preview"), { recursive: true });
  await writeFile(
    join(worktree, ".blame/preview/project.json"),
    JSON.stringify({
      projectName: "blame_000000000000",
      targets: { "web:http": { host: "127.0.0.1", port: ports["web:http"] } },
      serviceVolumes: {},
      volumeCreatedAt: {},
    }),
  );
  const server = createServer((_request, response) => response.end("ok"));
  server.listen(ports["web:http"]!, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  // The story's development preview runs.
  await startLocalPreviewServing(worktree);
  return { worktree, host, restarts: [] as string[], logs: [] as string[] };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
