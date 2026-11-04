import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { prepareGeneratedProjectPnpmBuilds } from "./project-creation-pnpm-builds.ts";
import {
  installGeneratedProjectDependencies,
  runProjectCommand,
} from "./project-creation-dependencies.ts";
import type { NewProjectConfiguration } from "./project-creation.ts";

const execFileAsync = promisify(execFile);
const configuration: NewProjectConfiguration = {
  platform: "web",
  frontend: "next",
  styling: "tailwind",
  uiLibrary: "shadcn",
  backend: "next-api",
  database: "postgresql",
  orm: "prisma",
  packageManager: "pnpm",
  codeQuality: "eslint-prettier",
  advancedOptions: [],
};

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  manifest = { packageManager: "pnpm@11.18.0" } as Record<string, unknown>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "blame-pnpm-builds-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ name: "app", ...manifest }),
  );
  return cwd;
}

/** Serves one tarball as a registry package: pnpm 10.34+ ignores name-based build approvals for local tarballs. */
async function serveRegistryPackage(
  t: { after(fn: () => Promise<void>): void },
  manifest: { name: string; version: string; scripts: Record<string, string> },
  tarball: Buffer,
) {
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const registry = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const server = createServer((request, response) => {
    if (request.url?.endsWith(".tgz")) return response.end(tarball);
    if (decodeURIComponent(request.url ?? "") !== `/${manifest.name}`) return response.writeHead(404).end();
    const tarballUrl = `${registry()}${manifest.name}/-/package-${manifest.version}.tgz`;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        name: manifest.name,
        "dist-tags": { latest: manifest.version },
        versions: { [manifest.version]: { ...manifest, dist: { tarball: tarballUrl, integrity } } },
        time: { [manifest.version]: "2020-01-01T00:00:00.000Z" },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return registry();
}

test("resolves pnpm 11 Prisma placeholders and preserves explicit decisions and workspace settings", async (t) => {
  const cwd = await fixture(t);
  await writeFile(
    join(cwd, "pnpm-workspace.yaml"),
    '# Project settings\npackages:\n  - apps/*\nstrictDepBuilds: true\nallowBuilds:\n  "@prisma/client": set this to true or false\n  "@prisma/engines": set this to true or false\n  prisma: set this to true or false\n  sharp: false\n  unrs-resolver: false\n  unreviewed-build: set this to true or false\n',
  );
  await prepareGeneratedProjectPnpmBuilds(cwd, configuration);
  const text = await readFile(join(cwd, "pnpm-workspace.yaml"), "utf8");
  const policy = parseYaml(text);
  assert.equal(policy.allowBuilds["@prisma/client"], true);
  assert.equal(policy.allowBuilds["@prisma/engines"], true);
  assert.equal(policy.allowBuilds.prisma, true);
  assert.equal(policy.allowBuilds.sharp, false);
  assert.equal(policy.allowBuilds["unrs-resolver"], false);
  assert.equal(
    policy.allowBuilds["unreviewed-build"],
    "set this to true or false",
  );
  assert.equal(policy.strictDepBuilds, true);
  assert.equal(policy.dangerouslyAllowAllBuilds, undefined);
  assert.deepEqual(policy.packages, ["apps/*"]);
  assert.match(text, /# Project settings/);
  await prepareGeneratedProjectPnpmBuilds(cwd, configuration);
  assert.equal(await readFile(join(cwd, "pnpm-workspace.yaml"), "utf8"), text);
});

test("migrates legacy build lists without conflicting pnpm 10.26+ settings", async (t) => {
  const cwd = await fixture(t, {
    packageManager: "pnpm@10.33.2",
    pnpm: {
      onlyBuiltDependencies: ["custom-approved"],
      ignoredBuiltDependencies: ["sharp"],
      overrides: { foo: "1.0.0" },
    },
  });
  await writeFile(
    join(cwd, "pnpm-workspace.yaml"),
    "onlyBuiltDependencies:\n  - another-approved\nneverBuiltDependencies:\n  - denied\n",
  );
  await prepareGeneratedProjectPnpmBuilds(cwd, configuration);
  const policy = parseYaml(
    await readFile(join(cwd, "pnpm-workspace.yaml"), "utf8"),
  );
  assert.equal(policy.onlyBuiltDependencies, undefined);
  assert.equal(policy.neverBuiltDependencies, undefined);
  assert.equal(policy.allowBuilds["custom-approved"], true);
  assert.equal(policy.allowBuilds["another-approved"], true);
  assert.equal(policy.allowBuilds.denied, false);
  assert.equal(policy.allowBuilds.sharp, false);
  assert.deepEqual(
    JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).pnpm,
    { overrides: { foo: "1.0.0" } },
  );
});

test("uses the legacy configuration for older pinned pnpm versions", async (t) => {
  const cwd = await fixture(t, { packageManager: "pnpm@10.25.0" });
  await prepareGeneratedProjectPnpmBuilds(cwd, configuration);
  const manifest = JSON.parse(
    await readFile(join(cwd, "package.json"), "utf8"),
  );
  assert.ok(manifest.pnpm.onlyBuiltDependencies.includes("@prisma/client"));
  await assert.rejects(readFile(join(cwd, "pnpm-workspace.yaml")), /ENOENT/);
});

test("creates modern build permissions when no workspace file exists", async (t) => {
  const cwd = await fixture(t);
  await prepareGeneratedProjectPnpmBuilds(cwd, configuration);
  const policy = parseYaml(
    await readFile(join(cwd, "pnpm-workspace.yaml"), "utf8"),
  );
  assert.equal(policy.allowBuilds["@prisma/client"], true);
  assert.equal(policy.allowBuilds.prisma, true);
});

test("installs and actually runs a previously blocked Prisma build script", async (t) => {
  // This fixture exercises the bundled pnpm 10 against a local registry, independently of the host CLI.
  const runtimeRequire = createRequire(new URL("../../../agent-runtime/package.json", import.meta.url));
  const pnpm10Root = dirname(runtimeRequire.resolve("pnpm-legacy"));
  const pnpm10 = join(pnpm10Root, "bin/pnpm.cjs");
  // Pin the bundled version, or pnpm 10 may switch to another cached pnpm and test that one.
  const { version } = JSON.parse(await readFile(join(pnpm10Root, "package.json"), "utf8"));
  const packageManager = `pnpm@${version}`;
  const cwd = await fixture(t, { packageManager });
  const dependency = await mkdtemp(join(tmpdir(), "blame-prisma-package-"));
  t.after(() => rm(dependency, { recursive: true, force: true }));
  const manifest = {
    name: "@prisma/client",
    version: "1.0.0",
    scripts: { postinstall: "node build.cjs" },
  };
  await writeFile(join(dependency, "package.json"), JSON.stringify(manifest));
  await writeFile(
    join(dependency, "build.cjs"),
    'require("node:fs").writeFileSync("built.txt", "build script ran");',
  );
  await execFileAsync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", dependency],
    { cwd: dependency },
  );
  const registry = await serveRegistryPackage(
    t,
    manifest,
    await readFile(join(dependency, "prisma-client-1.0.0.tgz")),
  );
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "app",
      packageManager,
      dependencies: { "@prisma/client": manifest.version },
    }),
  );
  await writeFile(join(cwd, "pnpm-workspace.yaml"), "strictDepBuilds: true\n");
  const logs: string[] = [];
  const run = (
    command: Parameters<typeof runProjectCommand>[0],
    emit: Parameters<typeof runProjectCommand>[1],
  ) =>
    runProjectCommand(
      {
        ...command,
        command: process.execPath,
        args: [
          pnpm10,
          ...command.args,
          "--registry",
          registry,
          "--store-dir",
          join(cwd, ".store"),
        ],
      },
      emit,
    );
  await assert.rejects(
    run(
      { command: "pnpm", args: ["install", "--no-frozen-lockfile"], cwd },
      (event) => logs.push(event.data),
    ),
    /exited with code 1/,
  );
  assert.match(logs.join(""), /IGNORED_BUILDS/);
  await assert.rejects(
    readFile(join(cwd, "node_modules/@prisma/client/built.txt")),
    /ENOENT/,
  );
  await installGeneratedProjectDependencies(
    cwd,
    configuration,
    (event) => logs.push(event.data),
    run,
  );
  assert.equal(
    await readFile(join(cwd, "node_modules/@prisma/client/built.txt"), "utf8"),
    "build script ran",
  );
});
