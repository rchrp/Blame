import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import test from "node:test";
import tar from "tar-stream";
import YAML from "yaml";
import { withDeploymentConfig } from "./package-deploy-config.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "blame-deploy-patches-"));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  const workspaceFile = join(root, "pnpm-workspace.yaml");
  const original =
    '# Keep normal installs strict.\npackages: ["packages/*"]\nallowBuilds: { pnpm: true, "node-pty": true }\n';
  await writeFile(workspaceFile, original);
  return { root, workspaceFile, original };
}

for (const cross of [false, true]) {
  test(`restores workspace policy after a failed ${cross ? "cross" : "native"} deployment`, async (t) => {
    const { workspaceFile, original } = await fixture(t);
    const target = cross
      ? {
          cpu: [process.arch === "x64" ? "arm64" : "x64"],
          os: [process.platform],
        }
      : undefined;
    const failure = new Error("Deploy failed");
    await assert.rejects(
      withDeploymentConfig(workspaceFile, target, async () => {
        const config = YAML.parse(await readFile(workspaceFile, "utf8"));
        assert.equal(config.allowUnusedPatches, true);
        assert.equal(config.allowBuilds.pnpm, !cross);
        assert.equal(config.allowBuilds["node-pty"], true);
        assert.deepEqual(config.supportedArchitectures, target);
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(await readFile(workspaceFile, "utf8"), original);
  });
}

test(
  "real pnpm production deploy tolerates omitted renderer patches and applies runtime patches",
  { timeout: 90_000 },
  async (t) => {
    const { root, workspaceFile } = await fixture(t);
    const rootManifest = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "deploy-fixture",
        private: true,
        packageManager: rootManifest.packageManager,
      }),
    );
    await mkdir(join(root, "packages/desktop"), { recursive: true });
    for (const name of ["runtime", "renderer"]) {
      await packageTarball(join(root, `${name}.tgz`), name);
      await writeFile(join(root, `${name}.patch`), patch(name));
    }
    await writeFile(
      join(root, "packages/desktop/package.json"),
      JSON.stringify({
        name: "@blame/desktop",
        version: "1.0.0",
        dependencies: { "fixture-runtime": "file:../../runtime.tgz" },
        devDependencies: { "fixture-renderer": "file:../../renderer.tgz" },
      }),
    );
    const original = `packages: ["packages/*"]\npatchedDependencies:\n  fixture-runtime@1.0.0: runtime.patch\n  fixture-renderer@1.0.0: renderer.patch\n`;
    await writeFile(workspaceFile, original);
    await pnpm(root, ["install", "--no-frozen-lockfile", "--ignore-scripts"]);
    const deploy = (destination) =>
      pnpm(root, [
        "--filter",
        "@blame/desktop",
        "deploy",
        "--prod",
        "--legacy",
        destination,
      ]);
    // This is the release failure: a full workspace install passes, but the
    // production subset excludes the renderer and rejects its registered patch.
    await assert.rejects(deploy("unconfigured"), /ERR_PNPM_UNUSED_PATCH/);
    await withDeploymentConfig(workspaceFile, undefined, () =>
      deploy("deployed"),
    );
    assert.equal(
      await readFile(
        join(root, "deployed/node_modules/fixture-runtime/index.js"),
        "utf8",
      ),
      'module.exports = "patched-runtime";\n',
    );
    await assert.rejects(
      stat(join(root, "deployed/node_modules/fixture-renderer")),
      { code: "ENOENT" },
    );
    assert.equal(await readFile(workspaceFile, "utf8"), original);
    // Allowing absent patches must never hide a broken patch for a dependency
    // that actually ships. Keep the normal strict patch-application behavior.
    await writeFile(
      join(root, "runtime.patch"),
      patch("runtime").replace("original-runtime", "missing-source"),
    );
    await assert.rejects(
      withDeploymentConfig(workspaceFile, undefined, () => deploy("broken")),
      /ERR_PNPM_PATCH_FAILED/,
    );
    assert.equal(await readFile(workspaceFile, "utf8"), original);
  },
);

async function packageTarball(path, name) {
  const archive = tar.pack();
  const writing = pipeline(archive, createGzip(), createWriteStream(path));
  archive.entry(
    { name: "package/package.json" },
    JSON.stringify({
      name: `fixture-${name}`,
      version: "1.0.0",
      main: "index.js",
    }),
  );
  archive.entry(
    { name: "package/index.js" },
    `module.exports = "original-${name}";\n`,
  );
  archive.finalize();
  await writing;
}

function patch(name) {
  return `diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = "original-${name}";\n+module.exports = "patched-${name}";\n`;
}

function pnpm(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`pnpm ${args.join(" ")}: ${output}`)),
    );
  });
}
