import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import {
  applyVersion,
  compareVersions,
  installedVersion,
  latestRelease,
  patchDependency,
  pinnedVersionFiles,
  regeneratePatches,
  versionPattern,
} from "./cline-sdk-update.mjs"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cline-sdk-update-"))
  const write = async (path, value) => {
    await mkdir(join(root, path, ".."), { recursive: true })
    await writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`)
  }
  await write("packages/agent-runtime/package.json", { dependencies: { "@cline/sdk": "0.0.82", "@cline/llms": "0.0.82", zod: "^4" } })
  await write("packages/api/package.json", { dependencies: { "@cline/llms": "0.0.82" } })
  await write("packages/app/package.json", { dependencies: { react: "^19" } })
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\npatchedDependencies:\n  '@cline/core@0.0.82': patches/@cline__core@0.0.82.patch\n  app-builder-lib@26.8.1: patches/app-builder-lib@26.8.1.patch\n")
  for (const path of pinnedVersionFiles) {
    await mkdir(join(root, path, ".."), { recursive: true })
    await writeFile(join(root, path), `version=0.0.82 other=10.0.821\n`)
  }
  const runtime = { runtimeVersion: "9", clineSdkVersion: "0.0.82" }
  await write("packages/desktop/resources/runtime/macos/manifest.json", runtime)
  await write("packages/desktop/resources/runtime/windows/manifest.json", runtime)
  return root
}

const read = async (root, path) => JSON.parse(await readFile(join(root, path), "utf8"))

test("versions compare numerically", () => {
  assert.ok(compareVersions("0.0.95", "0.0.82") > 0)
  assert.ok(compareVersions("0.0.100", "0.0.95") > 0)
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0)
})

test("apply pins every Cline package and bumps the runtime once", async () => {
  const root = await fixture()
  try {
    assert.equal(await installedVersion(root), "0.0.82")
    assert.deepEqual(await applyVersion("0.0.95", root), {
      runtimeVersion: "10",
      stalePatches: [{ dependency: "@cline/core@0.0.82", patch: "patches/@cline__core@0.0.82.patch" }],
    })
    const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8")
    assert.doesNotMatch(workspace, /@cline\/core/)
    assert.match(workspace, /app-builder-lib@26\.8\.1/)
    assert.deepEqual((await read(root, "packages/agent-runtime/package.json")).dependencies, { "@cline/sdk": "0.0.95", "@cline/llms": "0.0.95", zod: "^4" })
    assert.equal((await read(root, "packages/api/package.json")).dependencies["@cline/llms"], "0.0.95")
    assert.deepEqual((await read(root, "packages/app/package.json")).dependencies, { react: "^19" })
    for (const path of pinnedVersionFiles) {
      assert.equal(await readFile(join(root, path), "utf8"), "version=0.0.95 other=10.0.821\n", path)
    }
    for (const platform of ["macos", "windows"]) {
      assert.deepEqual(await read(root, `packages/desktop/resources/runtime/${platform}/manifest.json`), { runtimeVersion: "10", clineSdkVersion: "0.0.95" })
    }
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("a release missing for one Cline package is not applied", async () => {
  const published = {
    "@cline/sdk": { "dist-tags": { latest: "0.0.95" }, versions: { "0.0.95": {} } },
    "@cline/llms": { "dist-tags": { latest: "0.0.94" }, versions: { "0.0.94": {} } },
  }
  const request = async (url) => {
    const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1))
    return { ok: true, json: async () => published[name] }
  }
  await assert.rejects(latestRelease(["@cline/sdk", "@cline/llms"], request), /not published for @cline\/llms/)
  published["@cline/llms"].versions["0.0.95"] = {}
  assert.equal((await latestRelease(["@cline/sdk", "@cline/llms"], request)).latest, "0.0.95")
})

test("apply refuses a pinned file that no longer contains the version", async () => {
  const root = await fixture()
  try {
    await writeFile(join(root, pinnedVersionFiles[0]), "ARG BLAME_CLINE_SDK_VERSION=latest\n")
    await assert.rejects(applyVersion("0.0.95", root), /no longer pins Cline 0\.0\.82/)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("every runtime file pinning the installed SDK version is updated by apply", async () => {
  const repository = fileURLToPath(new URL("..", import.meta.url))
  const version = await installedVersion(repository)
  const tracked = execFileSync("git", ["ls-files", "packages/sandbox-runner", "packages/desktop/resources/runtime"], {
    cwd: repository,
    encoding: "utf8",
  }).split("\n").filter(Boolean)
  const covered = new Set([
    ...pinnedVersionFiles,
    "packages/desktop/resources/runtime/macos/manifest.json",
    "packages/desktop/resources/runtime/windows/manifest.json",
  ])
  const uncovered = []
  for (const path of tracked) {
    if (covered.has(path) || path.endsWith("package.json") || /\.(md|test\.ts)$/.test(path)) continue
    const text = await readFile(join(repository, path), "utf8").catch(() => "")
    if (versionPattern(version).test(text)) uncovered.push(path)
  }
  assert.deepEqual(uncovered, [], "add these files to pinnedVersionFiles")
})

test("patch paths map back to their dependency", () => {
  assert.equal(patchDependency("patches/@cline__core@0.0.82.patch"), "@cline/core")
  assert.equal(patchDependency("patches/app-builder-lib@26.8.1.patch"), "app-builder-lib")
})

test("patch regeneration in CI updates the lockfile and removes the stale patch", async () => {
  const root = await mkdtemp(join(tmpdir(), "cline-patch-ci-"))
  const previousCI = process.env.CI
  const previousRegistry = process.env.npm_config_registry
  process.env.CI = "true"
  let registry
  try {
    // pnpm patch fetches by name/version, so serve a tiny registry in another
    // process while the synchronous updater runs. No public npm requests.
    const version = "0.0.0-blame-fixture"
    const source = join(root, "source")
    await mkdir(source)
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "@cline/core", version, main: "index.js" }))
    await writeFile(join(source, "index.js"), "module.exports = 'original'\n")
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", root], { cwd: source, stdio: "pipe" })
    await writeFile(join(root, "registry.mjs"), `
      import { createServer } from 'node:http';
      import { readFileSync } from 'node:fs';
      const tarball = readFileSync(new URL('./cline-core-${version}.tgz', import.meta.url));
      const server = createServer((request, response) => {
        if (request.url.endsWith('.tgz')) return response.end(tarball);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ name: '@cline/core', 'dist-tags': { latest: '${version}' }, versions: {
          '${version}': { name: '@cline/core', version: '${version}', dist: { tarball: 'http://127.0.0.1:' + server.address().port + '/core.tgz' } }
        } }));
      });
      server.listen(0, '127.0.0.1', () => process.send(server.address().port));
    `)
    registry = spawn(process.execPath, [join(root, "registry.mjs")], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
    const [port] = await once(registry, "message")
    // pnpm run exports npm_config_registry, which takes precedence over .npmrc.
    process.env.npm_config_registry = `http://127.0.0.1:${port}`
    await writeFile(join(root, ".npmrc"), `registry=${process.env.npm_config_registry}\nstore-dir=${join(root, "store")}\ncache-dir=${join(root, "cache")}\n`)
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true, packageManager: "pnpm@10.33.2",
      dependencies: { "@cline/core": version },
    }))
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n")
    await mkdir(join(root, "scripts"))
    await writeFile(join(root, "scripts/patch-cline-core.mjs"),
      "import { writeFile } from 'node:fs/promises';\nimport { join } from 'node:path';\nawait writeFile(join(process.argv[2], 'index.js'), \"module.exports = 'patched'\\n\");\n")
    await mkdir(join(root, "patches"))
    const stale = "patches/@cline__core@0.0.95.patch"
    await writeFile(join(root, stale), "previous patch")
    execFileSync("pnpm", ["install", "--no-frozen-lockfile", "--ignore-scripts"], { cwd: root, stdio: "pipe" })

    assert.deepEqual(await regeneratePatches([stale], version, root), [])
    await assert.rejects(readFile(join(root, stale)), { code: "ENOENT" })
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: root, stdio: "pipe" })
    assert.equal(await readFile(join(root, "node_modules/@cline/core/index.js"), "utf8"), "module.exports = 'patched'\n")
  } finally {
    if (registry) {
      const exited = once(registry, "exit")
      registry.kill()
      await exited
    }
    if (previousCI === undefined) delete process.env.CI
    else process.env.CI = previousCI
    if (previousRegistry === undefined) delete process.env.npm_config_registry
    else process.env.npm_config_registry = previousRegistry
    await rm(root, { force: true, recursive: true })
  }
})
