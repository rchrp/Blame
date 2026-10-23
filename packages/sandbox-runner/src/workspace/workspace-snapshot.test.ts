import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSafeSymlink,
  forbiddenWorkspacePath,
  snapshotWorkspace,
} from "./workspace-snapshot.js";

test("remote snapshots exclude credential-bearing and generated paths", () => {
  for (const path of [
    ".env",
    ".env.local",
    ".npmrc",
    ".ssh/id_ed25519",
    ".docker/config.json",
    "node_modules/pkg/index.js",
    ".next/server.js",
    ".turbo/cache/state.bin",
    ".cache/tool/result",
    ".vite/deps/index.js",
    ".parcel-cache/data.bin",
    "dist/bundle.js",
    "packages/desktop/out/main/index.js",
    ".blame/runtime-tools/lima/bin/limactl",
    "server.log",
  ]) {
    assert.equal(forbiddenWorkspacePath(path), true, path);
  }
  assert.equal(forbiddenWorkspacePath(".env.example"), false);
  assert.equal(forbiddenWorkspacePath("src/index.ts"), false);
});

test("remote snapshots reject symlinks escaping the workspace", () => {
  assert.doesNotThrow(() =>
    assertSafeSymlink("packages/app/link", "../shared"),
  );
  assert.throws(
    () => assertSafeSymlink("link", "../outside"),
    /escapes workspace/,
  );
  assert.throws(() => assertSafeSymlink("link", "/etc/passwd"), /Unsafe/);
});

test("files a running app generates leave the gitignore-v1 hash unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-runner-snapshot-"));
  try {
    await mkdir(join(root, "apps/web/src/app"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "*.tsbuildinfo\n");
    await writeFile(
      join(root, "apps/web/.gitignore"),
      "next-env.d.ts\n/src/generated/prisma/\n",
    );
    await writeFile(join(root, "apps/web/src/app/page.tsx"), "export {}\n");
    const before = await snapshotWorkspace(root, "gitignore-v1");
    const legacyBefore = await snapshotWorkspace(root, "legacy");

    await mkdir(join(root, "apps/web/src/generated/prisma"), {
      recursive: true,
    });
    await writeFile(
      join(root, "apps/web/src/generated/prisma/client.ts"),
      "x\n",
    );
    await writeFile(join(root, "apps/web/next-env.d.ts"), "/// ref\n");
    await writeFile(join(root, "apps/web/tsconfig.tsbuildinfo"), "{}\n");

    const after = await snapshotWorkspace(root, "gitignore-v1");
    assert.equal(after.hash, before.hash);
    assert.equal(after.policy, "gitignore-v1");
    assert.deepEqual(Object.keys(after.files).sort(), [
      ".gitignore",
      "apps/web/.gitignore",
      "apps/web/src/app/page.tsx",
    ]);
    const legacyAfter = await snapshotWorkspace(root, "legacy");
    assert.notEqual(legacyAfter.hash, legacyBefore.hash);

    await writeFile(
      join(root, "apps/web/src/app/page.tsx"),
      "export const a = 1\n",
    );
    assert.notEqual(
      (await snapshotWorkspace(root, "gitignore-v1")).hash,
      before.hash,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
