import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  readdir,
  utimes,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { DockerHost } from "./docker-host.js";
import {
  setupServiceDigests,
  sharedSetupFor,
  type SharedSetupInput,
  type SharedSetupProject,
} from "./shared-setup.js";

const exec = promisify(execFile);

// The probe scripts run for real, like the ones of the Blame Runtime VM, with
// a fake `docker` that maps a volume to a directory. They need GNU find.
const gnuFind = await exec("find", [
  ".",
  "-maxdepth",
  "0",
  "-printf",
  "x",
]).then(
  () => true,
  () => false,
);
const options = { skip: !gnuFind || process.platform === "win32" };

const nodeModules = "blame_node_modules_abc123";
const storyCache = "blame_abcabcabcabc_cache-data";

async function fixture(root = "0") {
  const base = await realpath(await mkdtemp(join(tmpdir(), "shared-setup-")));
  const workspace = join(base, "worktree");
  const volumes = join(base, "volumes");
  for (const directory of [
    join(workspace, ".git"),
    join(workspace, ".blame", "preview"),
    join(workspace, "src"),
    join(volumes, nodeModules, "left-pad"),
    join(volumes, storyCache),
  ])
    await mkdir(directory, { recursive: true });
  await writeFile(join(workspace, "src", "app.ts"), "export {};\n");
  await writeFile(join(volumes, nodeModules, ".package-lock.json"), "{}");
  const prelude = [
    `id() { echo ${root}; }`,
    "command -v sha256sum >/dev/null || sha256sum() { shasum -a 256; }",
    `docker() { printf '%s\\n' "${volumes}/$5"; }`,
  ].join("\n");
  const host: DockerHost = {
    async run(_command, args) {
      try {
        const output = await exec("sh", ["-c", `${prelude}\n${args[1]}`]);
        return { ...output, exitCode: 0 };
      } catch (error) {
        const failure = error as { code: number; stdout: string };
        return { stdout: failure.stdout, stderr: "", exitCode: failure.code };
      }
    },
    readFile: async () => undefined,
    writeFile: async () => undefined,
  };
  const shared = sharedSetupFor({
    host,
    options: { directory: join(base, "shared"), workspace },
    task: {
      id: "install",
      container: { image: "node:24" },
      workingDir: "/workspace",
      command: "npm install",
      runAs: "host",
      environment: {},
      dependsOn: [],
    },
    serviceId: "setup-install",
    project: {
      serviceVolumes: { "setup-install": [nodeModules, storyCache] },
      volumeCreatedAt: { [nodeModules]: "2026-11-22T10:00:00Z" },
      sharedVolumes: [nodeModules],
      setupDigests: { "setup-install": "digest" },
    },
    fingerprint: "fingerprint",
    inputs: "inputs",
    marker: join(workspace, ".blame", "preview", "setup-install.marker"),
  })!;
  const volume = (...path: string[]) => join(volumes, nodeModules, ...path);
  return {
    base,
    workspace,
    shared,
    volume,
    storyCache: join(volumes, storyCache),
  };
}

// The marker and the run are some milliseconds apart in practice; wait out
// the clock's granularity.
const pause = () => new Promise((resolve) => setTimeout(resolve, 40));

async function run(
  context: Awaited<ReturnType<typeof fixture>>,
  change: () => Promise<void>,
) {
  assert.equal(await context.shared.claim(), "run");
  await pause();
  await change();
  const log: string[] = [];
  await context.shared.finish((message) => log.push(message));
  return log.join("");
}

async function installPackage(context: Awaited<ReturnType<typeof fixture>>) {
  await mkdir(context.volume("ms"), { recursive: true });
  await writeFile(context.volume("ms", "index.js"), "module.exports = 1;\n");
  await writeFile(context.volume(".package-lock.json"), '{"packages":{}}');
}

test(
  "stamps a run that only filled the volume, and trusts it until it changes",
  options,
  async (t) => {
    const context = await fixture();
    t.after(() => rm(context.base, { recursive: true, force: true }));
    assert.equal(await context.shared.done(), false, "nothing stamped yet");
    await run(context, () => installPackage(context));
    assert.equal(await context.shared.done(), true);

    // What tools write while the app runs does not count as a change.
    await mkdir(context.volume(".vite", "deps"), { recursive: true });
    await writeFile(context.volume(".vite", "deps", "react.js"), "export {}");
    await mkdir(context.volume(".cache"), { recursive: true });
    await writeFile(context.volume(".cache", "babel.json"), "{}");
    assert.equal(await context.shared.done(), true);

    // Another package installed in a container since is repaired by a rerun.
    await mkdir(context.volume("left-pad2"), { recursive: true });
    assert.equal(await context.shared.done(), false);
  },
);

for (const [name, change] of [
  [
    "a package removed",
    (context: Awaited<ReturnType<typeof fixture>>) =>
      rm(context.volume("left-pad"), { recursive: true }),
  ],
  [
    "a scoped package added",
    async (context: Awaited<ReturnType<typeof fixture>>) => {
      await mkdir(context.volume("@types", "node"), { recursive: true });
    },
  ],
  [
    "the package manager's record rewritten",
    (context: Awaited<ReturnType<typeof fixture>>) =>
      writeFile(context.volume(".package-lock.json"), '{"lockfileVersion":3}'),
  ],
] as const) {
  test(
    `${name} after the stamp makes the volume untrusted`,
    options,
    async (t) => {
      const context = await fixture();
      t.after(() => rm(context.base, { recursive: true, force: true }));
      await run(context, () => installPackage(context));
      assert.equal(await context.shared.done(), true);
      await change(context);
      assert.equal(await context.shared.done(), false);
    },
  );
}

for (const [name, change] of [
  [
    "a new file",
    (workspace: string) => writeFile(join(workspace, "gen.ts"), "export {};"),
  ],
  [
    "a new directory (a codegen output)",
    (workspace: string) => mkdir(join(workspace, ".nuxt")),
  ],
  [
    "a file written again with the same content",
    (workspace: string) =>
      writeFile(join(workspace, "src", "app.ts"), "export {};\n"),
  ],
  [
    "a file deleted",
    (workspace: string) => rm(join(workspace, "src", "app.ts")),
  ],
  [
    "a file renamed",
    (workspace: string) =>
      rename(join(workspace, "src", "app.ts"), join(workspace, "src", "b.ts")),
  ],
  [
    "a file whose date was set back",
    (workspace: string) =>
      utimes(join(workspace, "src", "app.ts"), new Date(0), new Date(0)),
  ],
  [
    "a file whose mode changed",
    (workspace: string) => chmod(join(workspace, "src", "app.ts"), 0o755),
  ],
] as const) {
  test(
    `does not stamp a run that wrote ${name} in the worktree`,
    options,
    async (t) => {
      const context = await fixture();
      t.after(() => rm(context.base, { recursive: true, force: true }));
      const log = await run(context, async () => {
        await installPackage(context);
        await change(context.workspace);
      });
      assert.match(log, /Setup install also wrote /);
      assert.equal(await context.shared.done(), false);
    },
  );
}

test(
  "what Blame and git write in the worktree is not the setup's",
  options,
  async (t) => {
    const context = await fixture();
    t.after(() => rm(context.base, { recursive: true, force: true }));
    const log = await run(context, async () => {
      await installPackage(context);
      await writeFile(join(context.workspace, ".git", "index"), "x");
      await mkdir(join(context.workspace, ".blame", "logs"), {
        recursive: true,
      });
      await writeFile(
        join(context.workspace, ".blame", "logs", "run.log"),
        "x",
      );
    });
    assert.equal(log, "");
    assert.equal(await context.shared.done(), true);
  },
);

test(
  "does not stamp a run that wrote in a volume only this story has",
  options,
  async (t) => {
    const context = await fixture();
    t.after(() => rm(context.base, { recursive: true, force: true }));
    const log = await run(context, async () => {
      await installPackage(context);
      await writeFile(join(context.storyCache, "state"), "x");
    });
    assert.match(log, new RegExp(`also wrote ${storyCache}`));
    assert.equal(await context.shared.done(), false);
  },
);

test(
  "a stamp is claimed by the first story and a changed volume loses it",
  options,
  async (t) => {
    const context = await fixture();
    t.after(() => rm(context.base, { recursive: true, force: true }));
    assert.equal(await context.shared.claim(), "run");
    await run(context, () => installPackage(context));
    assert.equal(await context.shared.done(), true);
    // Another story finds the volume filled and has nothing to run.
    assert.equal(await context.shared.claim(), "done");
    // The volume changed: the next run removes the stamp and, when it fails
    // and never calls finish, no stamp is left.
    await mkdir(context.volume("added-by-an-agent"));
    assert.equal(await context.shared.claim(), "run");
    assert.equal(await context.shared.done(), false);
  },
);

test(
  "a host that cannot read the volumes shares nothing",
  options,
  async (t) => {
    const context = await fixture("1000");
    t.after(() => rm(context.base, { recursive: true, force: true }));
    assert.equal(await context.shared.claim(), "unshared");
    await context.shared.finish();
    assert.equal(await context.shared.done(), false);
    await assert.rejects(readdir(join(context.base, "shared")), /ENOENT/);
  },
);

test("only a task with no dependency on shared, filled volumes is shared", () => {
  const project: SharedSetupProject = {
    serviceVolumes: { "setup-install": [nodeModules] },
    volumeCreatedAt: { [nodeModules]: "2026-11-22T10:00:00Z" },
    sharedVolumes: [nodeModules],
    setupDigests: { "setup-install": "digest" },
  };
  const base: SharedSetupInput = {
    host: {} as DockerHost,
    options: { directory: "/shared", workspace: "/worktrees/a" },
    task: {
      id: "install",
      container: { image: "node:24" },
      workingDir: "/workspace",
      command: "npm install",
      runAs: "host" as const,
      environment: {},
      dependsOn: [],
    },
    serviceId: "setup-install",
    project,
    fingerprint: "fingerprint",
    inputs: "inputs",
    marker: "/state/marker",
  };
  assert.ok(sharedSetupFor(base));
  const refused = (change: Partial<SharedSetupInput>) =>
    assert.equal(sharedSetupFor({ ...base, ...change }), undefined);
  refused({ options: undefined });
  refused({ inputs: undefined });
  refused({ task: { ...base.task, dependsOn: ["db"] } });
  refused({ task: { ...base.task, dependsOn: ["install"] } });
  refused({
    project: { ...project, sharedVolumes: [] },
  });
  refused({
    project: { ...project, setupDigests: {} },
  });
  refused({
    project: { ...project, volumeCreatedAt: { [nodeModules]: "" } },
  });
  refused({
    project: { ...project, volumeCreatedAt: {} },
  });
  refused({
    project: {
      ...project,
      serviceVolumes: {
        "setup-install": [nodeModules, "blame_node_modules_def456"],
      },
      volumeCreatedAt: {
        [nodeModules]: "t",
        blame_node_modules_def456: "t",
      },
      sharedVolumes: [nodeModules, "blame_node_modules_def456"],
    },
  });
  refused({
    project: {
      ...project,
      serviceVolumes: { "setup-install": ["not_a_dependency_volume"] },
      volumeCreatedAt: { not_a_dependency_volume: "t" },
      sharedVolumes: ["not_a_dependency_volume"],
    },
  });
});

test("only a plain install is shared: any other command may read or write the worktree", () => {
  const task = {
    id: "install",
    container: { image: "node:24" },
    workingDir: "/workspace",
    command: "npm install",
    runAs: "host" as const,
    environment: {},
    dependsOn: [],
  };
  const project: SharedSetupProject = {
    serviceVolumes: { "setup-install": [nodeModules] },
    volumeCreatedAt: { [nodeModules]: "2026-11-22T10:00:00Z" },
    sharedVolumes: [nodeModules],
    setupDigests: { "setup-install": "digest" },
  };
  const shared = (change: Partial<typeof task> & Record<string, unknown>) =>
    Boolean(
      sharedSetupFor({
        host: {} as DockerHost,
        options: { directory: "/shared", workspace: "/worktrees/a" },
        task: { ...task, ...change } as typeof task,
        serviceId: "setup-install",
        project,
        fingerprint: "fingerprint",
        inputs: "inputs",
        marker: "/state/marker",
      }),
    );
  for (const command of [
    "npm install",
    "npm install --no-package-lock",
    "npm ci",
    "corepack pnpm install",
    "corepack pnpm install --frozen-lockfile",
    "corepack prepare pnpm@10.33.2 --activate && corepack pnpm install --frozen-lockfile",
    "(corepack enable 2>/dev/null || true) && corepack pnpm install",
    "corepack yarn install --non-interactive",
    "yarn",
    "bun install --frozen-lockfile",
  ])
    assert.ok(shared({ command }), command);
  for (const command of [
    "npm install && node gen.mjs",
    "npm install && cp .env.example .env",
    "corepack pnpm install && corepack pnpm prisma generate",
    "npm ci && [ -f .env ] || cp .env.example .env",
    "npm install left-pad",
    "corepack pnpm install --filter web",
    "npm install; touch x",
    "npm install $(touch x)",
    "npm install --prefix=$(id)",
    "corepack enable",
    "pip install -r requirements.txt",
    "go mod download",
    "",
  ])
    assert.ok(!shared({ command }), command);
  assert.ok(!shared({ entrypoint: ["sh"] }));
  assert.ok(!shared({ container: { build: { context: "." } } as never }));
});

test("the digest of a setup container follows what it runs with, not where", () => {
  const yaml = (environment: Record<string, string>, workspace: string) =>
    [
      "services:",
      "  setup-install:",
      "    image: node:24",
      "    command: npm install",
      "    working_dir: /workspace",
      "    user: '1000:1000'",
      `    environment: ${JSON.stringify(environment)}`,
      `    volumes: ['${workspace}:/workspace']`,
      "  web:",
      "    image: node:24",
    ].join("\n");
  const digests = (environment: Record<string, string>, workspace: string) =>
    setupServiceDigests(yaml(environment, workspace));
  assert.deepEqual(Object.keys(digests({}, "/a")), ["setup-install"]);
  assert.equal(
    digests({ CI: "1" }, "/worktrees/a")["setup-install"],
    digests({ CI: "1" }, "/worktrees/b")["setup-install"],
  );
  assert.notEqual(
    digests({ NODE_ENV: "production" }, "/a")["setup-install"],
    digests({}, "/a")["setup-install"],
  );
  assert.deepEqual(setupServiceDigests("services: ["), {});
});
