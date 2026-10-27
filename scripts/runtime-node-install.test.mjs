import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const available = process.platform !== "win32" &&
  spawnSync("tar", ["--version"], { stdio: "ignore" }).status === 0;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function file(path, content, executable = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  if (executable) await chmod(path, 0o755);
}

// Model npm's actual failure: its CLI version still works, but an obsolete
// nested minipass shadows the new root dependency when loading npm install.
async function npmTree(root, stale = false) {
  const npm = join(root, "lib/node_modules/npm");
  await file(join(npm, "lib/commands/install.js"), "require('minipass-flush');\n");
  await file(join(npm, "node_modules/minipass-flush/index.js"),
    "const { Minipass } = require('minipass'); module.exports = class Flush extends Minipass {};\n");
  await file(join(npm, "node_modules/minipass/index.js"), "exports.Minipass = class Minipass {};\n");
  await file(join(npm, "bin/npm-cli.js"), "#!/usr/bin/env node\nconsole.log('11.19.1');\n", true);
  await mkdir(join(root, "bin"), { recursive: true });
  await symlink(process.execPath, join(root, "bin/node"));
  await symlink("../lib/node_modules/npm/bin/npm-cli.js", join(root, "bin/npm"));
  if (stale) await file(join(npm, "node_modules/minipass-flush/node_modules/minipass/index.js"),
    "module.exports = class Minipass {};\n");
}

async function fixture(platform, action) {
  const root = await mkdtemp(join(tmpdir(), "blame-node-install-"));
  const prefix = join(root, "installed");
  const staging = join(root, "staging");
  const archive = join(root, "node.tar.xz");
  const downloads = join(root, "downloads");
  try {
    await mkdir(staging);
    await npmTree(prefix, true);
    const source = await readFile(resolve(`packages/desktop/resources/runtime/${platform}/scripts/provision-blame-runtime.sh`), "utf8");
    const functions = source.slice(source.indexOf("ensure_node()"), source.indexOf("ensure_package_managers()"))
      .replaceAll("/usr/local", prefix);
    const run = (checksum) => spawnSync("sh", ["-c", `set -eu
node_version=${quote(process.versions.node)}
${functions}
node_archive_architecture() { printf x64; }
node_archive_sha256() { printf '%s' ${quote(checksum)}; }
curl() {
  printf download >>${quote(downloads)}
  while [ "$1" != "-o" ]; do shift; done
  cp ${quote(archive)} "$2"
}
sha256sum() { shasum -a 256 "$@"; }
ensure_node
`], { env: { ...process.env, PATH: `${join(prefix, "bin")}:${process.env.PATH}`, TMPDIR: staging }, encoding: "utf8", timeout: 15_000 });
    const pack = async (broken = false) => {
      const tree = join(root, "archive", "node-fixture");
      await npmTree(tree, broken);
      const result = spawnSync("tar", ["-cJf", archive, "-C", dirname(tree), "node-fixture"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return createHash("sha256").update(await readFile(archive)).digest("hex");
    };
    await action({ root, prefix, staging, archive, downloads, run, pack });
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const platform of ["macos", "windows"]) {
  test(`${platform} repairs npm even when Node and npm --version succeed`, { skip: !available }, () => fixture(platform, async ({ prefix, staging, downloads, run, pack }) => {
    const install = join(prefix, "lib/node_modules/npm/lib/commands/install.js");
    const before = spawnSync(process.execPath, ["-e", "require(process.argv[1])", install], { encoding: "utf8" });
    assert.match(before.stderr, /Class extends value undefined/);
    assert.equal(spawnSync(join(prefix, "bin/npm"), ["--version"]).status, 0);
    const preserved = join(prefix, "lib/node_modules/@blame/semantic-harness-runtime/keep");
    await file(preserved, "existing harness");
    const checksum = await pack();
    const result = run(checksum);
    assert.equal(result.status, 0, result.stderr);
    const after = spawnSync(process.execPath, ["-e", "require(process.argv[1])", install], { encoding: "utf8" });
    assert.equal(after.status, 0, after.stderr);
    assert.equal(await readFile(preserved, "utf8"), "existing harness");
    assert.deepEqual(await readdir(staging), []);
    assert.equal(run(checksum).status, 0);
    assert.equal(await readFile(downloads, "utf8"), "download", "Healthy Node/npm should not be reinstalled");
  }));

  test(`${platform} upgrades Node without retaining obsolete npm dependencies`, { skip: !available }, () => fixture(platform, async ({ prefix, run, pack }) => {
    // This executable represents the previous Node version, which fails the
    // version check. Never overwrite the symlink to the host's real Node.
    await rm(join(prefix, "bin/node"));
    await file(join(prefix, "bin/node"), "#!/bin/sh\nexit 1\n", true);
    const result = run(await pack());
    assert.equal(result.status, 0, result.stderr);
    const after = spawnSync(join(prefix, "bin/node"), ["-e", "require(process.argv[1])", join(prefix, "lib/node_modules/npm/lib/commands/install.js")], { encoding: "utf8" });
    assert.equal(after.status, 0, after.stderr);
  }));

  for (const failure of ["checksum", "archive", "installer"]) {
    test(`${platform} rejects a bad ${failure} before replacing the installation`, { skip: !available }, () => fixture(platform, async ({ root, prefix, staging, archive, run, pack }) => {
      const snapshot = join(root, "before");
      await cp(prefix, snapshot, { recursive: true, verbatimSymlinks: true });
      let checksum = await pack(failure === "installer");
      if (failure === "checksum") checksum = "0".repeat(64);
      if (failure === "archive") {
        await writeFile(archive, "incomplete archive");
        checksum = createHash("sha256").update(await readFile(archive)).digest("hex");
      }
      const result = run(checksum);
      assert.notEqual(result.status, 0, "An unusable archive was accepted");
      const diff = spawnSync("diff", ["-r", snapshot, prefix], { encoding: "utf8" });
      assert.equal(diff.status, 0, diff.stdout || diff.stderr);
      assert.deepEqual(await readdir(staging), [], "Failed staging must be removed");
    }));
  }
}
