import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const available = process.platform !== "win32";
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function provisioningFunctions(source) {
  const body = (name) => {
    const start = source.indexOf(`${name}() {`);
    assert.notEqual(start, -1, name);
    return source.slice(start, source.indexOf("\n}\n", start) + 3);
  };
  return [body("ensure_package_manager"), body("directly_executable")].join("\n");
}

// npm as the provisioning sees it with --ignore-scripts: pnpm 12's package
// with its shebang-less placeholder, and the install script that would put
// the native binary (here a script with a shebang) in its place.
const fakeNpm = `npm() {
  printf 'install\\n' >>"$npm_log"
  while [ "$1" != "--prefix" ]; do shift; done
  wrapper="$2/node_modules/pnpm"
  mkdir -p "$wrapper" "$2/node_modules/.bin"
  printf 'echo 12.15.0\\n' >"$wrapper/pnpm"
  chmod 755 "$wrapper/pnpm"
  : >"$wrapper/native-binary.mjs"
  printf '%s\\n' "require('fs').writeFileSync('pnpm', '#!/bin/sh\\\\necho 12.15.0\\\\n', { mode: 0o755 })" >"$wrapper/install.js"
  ln -sf ../pnpm/pnpm "$2/node_modules/.bin/pnpm"
}`;

async function fixture(platform, action) {
  const root = await mkdtemp(join(tmpdir(), "blame-package-manager-"));
  try {
    const source = await readFile(
      resolve(`packages/desktop/resources/runtime/${platform}/scripts/provision-blame-runtime.sh`),
      "utf8",
    );
    const log = join(root, "npm.log");
    const run = (prelude = "") => spawnSync("sh", ["-c", `set -eu
package_manager_root=${quote(root)}
npm_log=${quote(log)}
${provisioningFunctions(source)}
${fakeNpm}
${prelude}
ensure_package_manager pnpm 12.15.0
`], { encoding: "utf8", timeout: 15_000 });
    const installs = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    await action({ root, run, installs });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const head = (path) => spawnSync("head", ["-c", "2", path], { encoding: "utf8" }).stdout;

for (const platform of ["macos", "windows"]) {
  test(`${platform} installs pnpm's native binary in place of its placeholder`, { skip: !available }, () =>
    fixture(platform, async ({ root, run, installs }) => {
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await installs(), 1);
      assert.equal(head(join(root, "pnpm/12.15.0/node_modules/pnpm/pnpm")), "#!");
      assert.equal(run().status, 0);
      assert.equal(await installs(), 1, "a working installation is kept");
    }));

  test(`${platform} reinstalls a pnpm that only a shell can run`, { skip: !available }, () =>
    fixture(platform, async ({ root, run, installs }) => {
      // The runtime images up to now: --version answers through sh.
      const placeholder = `npm --prefix "$package_manager_root/pnpm/12.15.0" pnpm@12.15.0
mkdir -p "$package_manager_root/pnpm/12.15.0/bin"
ln -sf ../node_modules/.bin/pnpm "$package_manager_root/pnpm/12.15.0/bin/pnpm"
: >"$npm_log"`;
      const result = run(placeholder);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await installs(), 1);
      assert.equal(head(join(root, "pnpm/12.15.0/node_modules/pnpm/pnpm")), "#!");
    }));
}
