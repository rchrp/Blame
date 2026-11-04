import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePackageManager } from "./package-manager-runtime.js";

for (const [name, version] of [
  ["pnpm", "12.15.0"],
  ["pnpm", "10.34.9"],
  ["npm", "12.2.1"],
  ["npm", "11.6.4"],
] as const) {
  test(`runs bundled ${name} ${version} without package-manager downloads`, async () => {
    const root = await mkdtemp(join(tmpdir(), "blame-pnpm-compat-"));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ packageManager: `${name}@${version}` }),
      );
      const manager = await resolvePackageManager({ name, version });
      const result = await promisify(execFile)(
        manager.executable,
        [...manager.argsPrefix, "--version"],
        {
          cwd: root,
          env: {
            ...process.env,
            COREPACK_ENABLE_NETWORK: "0",
            npm_config_manage_package_manager_versions: "false",
          },
          timeout: 10_000,
        },
      );
      assert.equal(result.stdout.trim(), version);
      assert.equal(manager.resolvedVersion, version);
      if (name === "pnpm" && version.startsWith("12."))
        assert.deepEqual(manager.argsPrefix, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("runs the bundled pnpm 10 for a project pinned to a retired pnpm 10", async () => {
  // Runtime upgrades remove pnpm 10.33.2, which projects created before may pin.
  const manager = await resolvePackageManager({
    name: "pnpm",
    version: "10.33.2",
    compatibility: "pnpm_same_major",
  });
  assert.equal(manager.resolvedVersion, "10.34.9");
  assert.equal(manager.resolutionStrategy, "compatible_same_major");
});
