import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  generatedProjectInstallCommands,
  installGeneratedProjectDependencies,
  runProjectCommand,
} from "./project-creation-dependencies.ts";
import type { NewProjectConfiguration } from "./project-creation.ts";

const configuration: NewProjectConfiguration = {
  platform: "web",
  frontend: "react-vite",
  styling: "vanilla-css",
  uiLibrary: "none",
  backend: "none",
  database: "none",
  orm: "none",
  packageManager: "pnpm",
  codeQuality: "none",
  advancedOptions: [],
};

test("installs with each selected Node package manager even without node_modules", async (t) => {
  const target = await mkdtemp(join(tmpdir(), "blame-install-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  await writeFile(join(target, "package.json"), '{"name":"app"}');
  for (const packageManager of ["npm", "pnpm", "yarn", "bun"] as const) {
    const commands = await generatedProjectInstallCommands(target, {
      ...configuration,
      packageManager,
    });
    assert.deepEqual(commands, [
      {
        command: packageManager,
        args:
          packageManager === "pnpm"
            ? ["install", "--no-frozen-lockfile"]
            : ["install"],
        cwd: target,
      },
    ]);
  }
});

test("installs a workspace once at its root and honors its declared manager", async (t) => {
  const target = await mkdtemp(join(tmpdir(), "blame-workspace-install-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  await mkdir(join(target, "apps", "web"), { recursive: true });
  await writeFile(
    join(target, "package.json"),
    JSON.stringify({ workspaces: ["apps/*"], packageManager: "yarn@4.0.0" }),
  );
  await writeFile(
    join(target, "apps", "web", "package.json"),
    '{"name":"web"}',
  );
  assert.deepEqual(
    await generatedProjectInstallCommands(target, configuration),
    [{ command: "yarn", args: ["install"], cwd: target }],
  );
});

test("installs independent frontend and backend manifests and ignores generated dependencies", async (t) => {
  const target = await mkdtemp(join(tmpdir(), "blame-nested-install-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  for (const folder of [
    "apps/web",
    "api",
    "node_modules/ignored",
    ".blame/ignored",
  ]) {
    await mkdir(join(target, folder), { recursive: true });
    await writeFile(join(target, folder, "package.json"), '{"name":"app"}');
  }
  await writeFile(join(target, "api", "package-lock.json"), "{}");
  const commands = await generatedProjectInstallCommands(target, configuration);
  assert.equal(commands.length, 2);
  assert.equal(
    commands.find(({ cwd }) => cwd === join(target, "api"))?.command,
    "npm",
  );
  assert.equal(
    commands.find(({ cwd }) => cwd === join(target, "apps/web"))?.command,
    "pnpm",
  );
});

test("installs independent packages excluded from a pnpm workspace", async (t) => {
  const target = await mkdtemp(join(tmpdir(), "blame-workspace-exclusions-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  await writeFile(join(target, "package.json"), '{"name":"root"}');
  await writeFile(
    join(target, "pnpm-workspace.yaml"),
    'packages:\n  - "apps/*"\n  - "!apps/standalone"\n',
  );
  for (const folder of ["apps/web", "apps/standalone", "api"]) {
    await mkdir(join(target, folder), { recursive: true });
    await writeFile(
      join(target, folder, "package.json"),
      '{"name":"app","packageManager":"npm@11.0.0"}',
    );
  }
  const commands = await generatedProjectInstallCommands(target, configuration);
  assert.deepEqual(
    commands.map(({ cwd }) => cwd).sort(),
    [target, join(target, "api"), join(target, "apps/standalone")].sort(),
  );
});

test("installs Python dependencies in a local environment alongside the frontend", async (t) => {
  const target = await mkdtemp(join(tmpdir(), "blame-python-install-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  await writeFile(join(target, "package.json"), '{"name":"app"}');
  await writeFile(join(target, "pyproject.toml"), '[project]\nname = "api"\n');
  for (const packageManager of ["uv", "poetry", "pip"] as const) {
    const commands = await generatedProjectInstallCommands(target, {
      ...configuration,
      backend: "fastapi",
      packageManager,
    });
    assert.equal(commands[0]?.command, "npm");
    assert.deepEqual(commands[1]?.args.slice(0, 2), ["-m", "venv"]);
    assert.ok(commands.at(-1)?.command.startsWith(target));
    assert.deepEqual(commands.at(-1)?.args.slice(0, 2), ["-m", packageManager]);
  }
});

test("really installs a local npm dependency and streams completion only afterward", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "blame real install "));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = join(parent, "app");
  await mkdir(target);
  await mkdir(join(parent, "dependency"));
  await writeFile(
    join(parent, "dependency", "package.json"),
    JSON.stringify({
      name: "fixture-dependency",
      version: "1.0.0",
      main: "index.js",
    }),
  );
  await writeFile(
    join(parent, "dependency", "index.js"),
    'module.exports = "installed";',
  );
  await writeFile(
    join(target, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      dependencies: { "fixture-dependency": "file:../dependency" },
    }),
  );
  const logs: string[] = [];
  await installGeneratedProjectDependencies(
    target,
    { ...configuration, packageManager: "npm" },
    (event) => logs.push(event.data),
    (command, emit) =>
      runProjectCommand(
        {
          ...command,
          args: [...command.args, "--offline", "--no-audit", "--no-fund"],
        },
        emit,
      ),
  );
  assert.match(
    await readFile(
      join(target, "node_modules/fixture-dependency/index.js"),
      "utf8",
    ),
    /installed/,
  );
  assert.match(
    await readFile(join(target, "package-lock.json"), "utf8"),
    /fixture-dependency/,
  );
  assert.equal(logs.at(-1), "Project dependencies installed.\n");
});

test("a nonzero installer exit fails creation instead of reporting success", async () => {
  await assert.rejects(
    runProjectCommand(
      {
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        cwd: tmpdir(),
      },
      () => undefined,
    ),
    /exited with code 7/,
  );
});
