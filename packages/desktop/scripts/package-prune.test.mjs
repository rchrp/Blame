import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pruneNodeModules } from "./package-prune.mjs";

const files = [
  "node_modules/plain/index.js",
  "node_modules/plain/index.js.map",
  "node_modules/plain/index.d.ts",
  "node_modules/plain/README.md",
  "node_modules/plain/LICENSE.md",
  "node_modules/plain/src/index.ts",
  "node_modules/plain/test/index.js",
  "node_modules/plain/lib/test/helper.js",
  "node_modules/@scope/pkg/index.mjs",
  "node_modules/@scope/pkg/types.d.mts",
  "node_modules/@scope/pkg/tests/spec.js",
  "node_modules/.pnpm/nested@1.0.0/node_modules/nested/index.js",
  "node_modules/.pnpm/nested@1.0.0/node_modules/nested/examples/demo.js",
  "node_modules/.pnpm/nested@1.0.0/node_modules/nested/CHANGELOG.md",
  "node_modules/grammar/index.js",
  "node_modules/grammar/src/parser.c",
  "node_modules/grammar/prebuilds/prebuild-macOS-ARM64/parser.so",
  "node_modules/grammar/prebuilds/prebuild-macOS-X64/parser.so",
  "node_modules/grammar/prebuilds/prebuild-Linux-X64/parser.so",
  "node_modules/unbuilt-grammar/src/parser.c",
  "node_modules/unbuilt-grammar/prebuilds/prebuild-Linux-X64/parser.so",
  "node_modules/native/src/index.js",
  "node_modules/native/prebuilds/prebuild-Linux-X64/addon.node",
  "node_modules/pty/prebuilds/darwin-arm64/pty.node",
  "node_modules/pty/prebuilds/darwin-x64/pty.node",
  "node_modules/pty/prebuilds/win32-x64/pty.node",
];

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), "blame-package-prune-"));
  try {
    for (const file of files) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), "content");
    }
    await mkdir(join(root, "node_modules/linked"), { recursive: true });
    await symlink(
      join(root, "node_modules/plain"),
      join(root, "node_modules/linked/target"),
    );
    await action(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function present(root, file) {
  return access(join(root, file)).then(
    () => true,
    () => false,
  );
}

test("removes files the packaged app never loads", async () => {
  await fixture(async (root) => {
    const removed = await pruneNodeModules(root, {
      arch: "arm64",
      platform: "darwin",
    });

    const kept = [
      "node_modules/plain/index.js",
      "node_modules/plain/index.d.ts",
      "node_modules/plain/LICENSE.md",
      "node_modules/plain/lib/test/helper.js",
      "node_modules/@scope/pkg/index.mjs",
      "node_modules/@scope/pkg/types.d.mts",
      "node_modules/.pnpm/nested@1.0.0/node_modules/nested/index.js",
      "node_modules/grammar/index.js",
      "node_modules/grammar/prebuilds/prebuild-macOS-ARM64/parser.so",
      "node_modules/unbuilt-grammar/src/parser.c",
      "node_modules/unbuilt-grammar/prebuilds/prebuild-Linux-X64/parser.so",
      "node_modules/native/src/index.js",
      "node_modules/native/prebuilds/prebuild-Linux-X64/addon.node",
      "node_modules/pty/prebuilds/darwin-arm64/pty.node",
      "node_modules/linked/target/index.js",
    ];
    const gone = [
      "node_modules/plain/index.js.map",
      "node_modules/plain/README.md",
      "node_modules/plain/src/index.ts",
      "node_modules/plain/test",
      "node_modules/@scope/pkg/tests",
      "node_modules/.pnpm/nested@1.0.0/node_modules/nested/examples",
      "node_modules/.pnpm/nested@1.0.0/node_modules/nested/CHANGELOG.md",
      "node_modules/grammar/src",
      "node_modules/grammar/prebuilds/prebuild-macOS-X64",
      "node_modules/grammar/prebuilds/prebuild-Linux-X64",
      "node_modules/pty/prebuilds/darwin-x64",
      "node_modules/pty/prebuilds/win32-x64",
    ];
    for (const file of kept)
      assert.ok(await present(root, file), `kept ${file}`);
    for (const file of gone)
      assert.ok(!(await present(root, file)), `removed ${file}`);
    assert.equal(removed.files, 12);
    assert.equal(removed.bytes, 12 * "content".length);
  });
});

test("keeps every binary for a target without prebuilds", async () => {
  await fixture(async (root) => {
    await pruneNodeModules(root, { arch: "ia32", platform: "win32" });
    assert.ok(await present(root, "node_modules/grammar/src/parser.c"));
    assert.ok(
      await present(root, "node_modules/grammar/prebuilds/prebuild-Linux-X64"),
    );
    assert.ok(await present(root, "node_modules/pty/prebuilds/darwin-x64"));
  });
});
