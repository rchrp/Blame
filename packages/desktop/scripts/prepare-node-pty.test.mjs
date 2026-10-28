import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import test from "node:test";
import { prepareNodePtyHelpers, verifyNodePtyHelpers } from "./prepare-node-pty.mjs";

const require = createRequire(import.meta.url);
const exec = promisify(execFile);

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), "blame pty test "));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function helper(root, directory, mode = 0o644) {
  const path = join(root, directory, "spawn-helper");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "helper fixture", { mode });
  return path;
}

test("repairs both Darwin architectures and compiled helpers without changing their contents", {
  skip: process.platform === "win32",
}, () => fixture(async (root) => {
  const paths = await Promise.all(["build/Release", "build/Debug", "prebuilds/darwin-arm64", "prebuilds/darwin-x64"]
    .map(directory => helper(root, directory)));
  await assert.rejects(verifyNodePtyHelpers(root), /not executable/);
  await prepareNodePtyHelpers(root, "darwin");
  await verifyNodePtyHelpers(root);
  const first = await Promise.all(paths.map(path => stat(path)));
  await prepareNodePtyHelpers(root, "darwin");
  for (const [index, path] of paths.entries()) {
    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o755);
    assert.equal(info.ctimeMs, first[index].ctimeMs, "already executable helpers must not be rewritten");
    assert.equal(await readFile(path, "utf8"), "helper fixture");
  }
}));

test("does not require or modify Darwin helpers on Windows and Linux", () => fixture(async (root) => {
  await prepareNodePtyHelpers(root, "win32");
  await prepareNodePtyHelpers(root, "linux");
  const path = await helper(root, "prebuilds/darwin-arm64");
  const before = await stat(path);
  await prepareNodePtyHelpers(root, "linux");
  assert.equal((await stat(path)).mode, before.mode);
}));

test("fails clearly for missing or invalid helpers", () => fixture(async (root) => {
  await assert.rejects(prepareNodePtyHelpers(root, "darwin"), /No macOS node-pty spawn-helper/);
  await assert.rejects(verifyNodePtyHelpers(root), /No macOS node-pty spawn-helper/);
  await mkdir(join(root, "build/Release/spawn-helper"), { recursive: true });
  await assert.rejects(prepareNodePtyHelpers(root, "darwin"), /not a regular file/);
}));

test("does not follow helper symlinks outside the package", { skip: process.platform === "win32" }, () => fixture(async (root) => {
  const outside = await helper(root, "outside");
  await mkdir(join(root, "package/build/Release"), { recursive: true });
  await symlink(outside, join(root, "package/build/Release/spawn-helper"));
  await assert.rejects(prepareNodePtyHelpers(join(root, "package"), "darwin"), /not a regular file/);
  assert.equal((await stat(outside)).mode & 0o777, 0o644);
}));

async function spawnTerminal(packageRoot) {
  return exec(require("electron"), ["-e", `
const pty = require(process.argv[1]);
const terminal = pty.spawn('/bin/zsh', ['-f', '-c', 'printf BLAME_PTY_OK'], {
  cwd: process.cwd(), env: process.env, name: 'xterm-256color', cols: 80, rows: 24,
});
terminal.onData(data => process.stdout.write(data));
terminal.onExit(({ exitCode }) => process.exit(exitCode));
setTimeout(() => { terminal.kill(); process.exit(2); }, 5000).unref();
`, packageRoot], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 10_000 });
}

test("real Electron PTYs recover from non-executable prebuilds in development and ASAR packages", {
  skip: process.platform !== "darwin",
  timeout: 30_000,
}, () => fixture(async (root) => {
  const source = dirname(require.resolve("node-pty/package.json"));
  const stage = join(root, "stage");
  const packageRoot = join(stage, "node_modules/node-pty");
  const prebuild = `prebuilds/darwin-${process.arch}`;
  await mkdir(packageRoot, { recursive: true });
  for (const path of ["package.json", "lib", prebuild]) {
    await cp(join(source, path), join(packageRoot, path), { recursive: true });
  }
  const binary = join(packageRoot, prebuild, "spawn-helper");
  await chmod(binary, 0o644);
  await assert.rejects(spawnTerminal(packageRoot), /posix_spawn/);
  await prepareNodePtyHelpers(packageRoot);
  assert.match((await spawnTerminal(packageRoot)).stdout, /BLAME_PTY_OK/);

  // Recreate the mode from the published tarball inside a real packaged app.
  // Electron must load JS through ASAR and launch the unpacked native helper.
  await chmod(binary, 0o644);
  const builder = createRequire(require.resolve("electron-builder"));
  const asar = createRequire(builder.resolve("app-builder-lib"))("@electron/asar");
  const archive = join(root, "app.asar");
  await finished(await asar.createPackageWithOptions(stage, archive, { unpackDir: "**/prebuilds" }));
  const packaged = join(archive, "node_modules/node-pty");
  const unpacked = join(`${archive}.unpacked`, "node_modules/node-pty");
  await assert.rejects(verifyNodePtyHelpers(unpacked), /not executable/);
  await assert.rejects(spawnTerminal(packaged), /posix_spawn/);
  await prepareNodePtyHelpers(unpacked);
  await verifyNodePtyHelpers(unpacked);
  assert.match((await spawnTerminal(packaged)).stdout, /BLAME_PTY_OK/);
}));
