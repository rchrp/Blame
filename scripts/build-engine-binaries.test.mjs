import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildEngineBinaries,
  engineExecutables,
  engineTargets,
  packagedEngineTargets,
  stageEngineBinaries,
} from "./build-engine-binaries.mjs";

test("a package carries its own target and the VM's Linux one", () => {
  assert.deepEqual(packagedEngineTargets("darwin", "arm64"), [
    "darwin-arm64",
    "linux-arm64",
  ]);
  assert.deepEqual(packagedEngineTargets("darwin", "x64"), [
    "darwin-x64",
    "linux-x64",
  ]);
  assert.deepEqual(packagedEngineTargets("win32", "x64"), [
    "win32-x64",
    "linux-x64",
  ]);
  assert.deepEqual(packagedEngineTargets("linux", "x64"), ["linux-x64"]);
  for (const platform of ["darwin", "win32", "linux"])
    for (const target of packagedEngineTargets(platform, "x64"))
      assert.ok(engineTargets[target], target);
  assert.deepEqual(engineExecutables("win32-x64"), ["blame-engine.exe"]);
  assert.deepEqual(engineExecutables("linux-arm64"), [
    "blame-engine",
    "blame-harness",
  ]);
});

test("Linux targets are static musl builds", () => {
  for (const [target, spec] of Object.entries(engineTargets))
    if (target.startsWith("linux-"))
      assert.match(spec.triple, /-unknown-linux-musl$/);
});

test("stages prebuilt binaries as executables and names what is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-engine-binaries-"));
  try {
    const prebuiltDir = join(root, "prebuilt");
    for (const target of ["win32-x64", "linux-x64"]) {
      await mkdir(join(prebuiltDir, target), { recursive: true });
      for (const executable of engineExecutables(target))
        await writeFile(join(prebuiltDir, target, executable), target, {
          mode: 0o644,
        });
    }
    const resources = join(root, "resources/engine");
    const staged = await stageEngineBinaries(resources, {
      platform: "win32",
      arch: "x64",
      prebuiltDir,
    });
    assert.equal(staged.length, 3);
    assert.deepEqual((await readdir(resources)).sort(), [
      "linux-x64",
      "win32-x64",
    ]);
    if (process.platform !== "win32")
      assert.equal(
        (await stat(join(resources, "linux-x64/blame-engine"))).mode & 0o777,
        0o755,
      );
    await assert.rejects(
      stageEngineBinaries(join(root, "other"), {
        platform: "darwin",
        arch: "x64",
        prebuiltDir,
      }),
      /No darwin-x64 blame-engine in .*prebuilt: build it with `node scripts\/build-engine-binaries.mjs darwin-x64`/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a target this platform does not build", async () => {
  const foreign = Object.keys(engineTargets).find(
    (target) => !engineTargets[target].builds.includes(process.platform),
  );
  await assert.rejects(buildEngineBinaries([foreign]), /are built on/);
  await assert.rejects(
    buildEngineBinaries(["plan9-x64"]),
    /Unknown engine target/,
  );
});
