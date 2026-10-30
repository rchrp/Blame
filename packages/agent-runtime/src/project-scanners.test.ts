import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { scanProjectCodePractices } from "./project-code-practices-scan.js";
import { scanProjectForInitialization } from "./project-initialization.js";

test("discovers nested multi-ecosystem projects from a parent folder", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "blame-project-parent-"));
  const external = await mkdtemp(join(tmpdir(), "blame-project-external-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  context.after(() => rm(external, { force: true, recursive: true }));
  await writeProjectFixture(root, projectFixture());
  await writeProjectFixture(external, {
    "package.json": JSON.stringify({ name: "outside-workspace" }),
  });
  await symlink(external, join(root, "linked-project"), "dir");

  const scan = await scanProjectForInitialization(root);

  assertManifestDiscovery(scan);
  assertSafeEvidence(scan);
  assert.ok(
    scan.discovery?.entrypointPaths.includes("random/server/app/main.py"),
  );
  assert.ok(
    scan.discovery?.migrationPaths.includes(
      "random/server/database/migrations/001_create_users.sql",
    ),
  );
  assert.ok("random/server/app/main.py" in scan.files);
  // Screen previews need images the agent cannot guess.
  assert.match(scan.previewImages?.electron ?? "", /blame-gui-node@sha256:/);
  assert.match(scan.previewImages?.tauri ?? "", /blame-gui-tauri@sha256:/);
});

test("discovers practices without assuming Node or conventional folders", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "blame-practices-parent-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeProjectFixture(root, projectFixture());

  const scan = await scanProjectCodePractices(root);

  assertPracticesScan(scan);
});

function assertPracticesScan(
  scan: Awaited<ReturnType<typeof scanProjectCodePractices>>,
) {
  assert.equal(scan.version, 2);
  assert.ok("random/server/pyproject.toml" in scan.manifests);
  assert.ok("deep/tools/rust/Cargo.toml" in scan.manifests);
  assert.ok("random/server/ruff.toml" in scan.configurations);
  assert.ok(scan.tests.paths.includes("random/server/tests/test_users.py"));
  assert.equal(scan.tests.fileCount, 1);
  assert.ok(
    scan.inventory.architecturePaths.includes(
      "random/server/domain/user_service.py",
    ),
  );
  assert.equal(
    scan.inventory.projectRoots.some(({ path }) =>
      path.includes("node_modules"),
    ),
    false,
  );
  assertGeneratedOutputsIgnored(scan);
}

function assertGeneratedOutputsIgnored(
  scan: Awaited<ReturnType<typeof scanProjectCodePractices>>,
) {
  assert.equal(
    scan.inventory.projectRoots.some(
      ({ path }) => path === "random/server/build",
    ),
    false,
  );
  assert.equal(
    scan.source.representativePaths.some((path) => path.includes("/build/")),
    false,
  );
}

test("keeps an unstructured source-only project analyzable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "blame-unstructured-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeProjectFixture(root, {
    ".git/HEAD": "ref: refs/heads/main",
    "deps/beginner/main.ex": "defmodule Beginner do end",
    "some/unknown/folder/main.py": "print('hello')",
    "some/unknown/folder/test_main.py": "def test_main(): assert True",
    "site/index.html": "<main>Hello</main>",
    "site/styles.css": "main { display: block; }",
    "target/beginner/main.rs": "fn main() {}",
    "vendor/beginner/main.py": "print('vendor project')",
  });

  const [initialization, practices] = await Promise.all([
    scanProjectForInitialization(root),
    scanProjectCodePractices(root),
  ]);

  assert.ok("some/unknown/folder/main.py" in initialization.files);
  assert.ok(
    initialization.discovery?.projectRoots.some(
      ({ path }) => path === "some/unknown/folder",
    ),
  );
  assert.equal(practices.source.fileCount, 6);
  assert.equal(practices.tests.fileCount, 1);
});

test("preserves an explicit project nested below a generated-looking folder", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "blame-build-project-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeProjectFixture(root, {
    "package.json": JSON.stringify({ name: "parent" }),
    "src/main.ts": "export const parent = true",
    "build/custom/package.json": JSON.stringify({ name: "nested-project" }),
    "build/custom/src/main.ts": "export const nested = true",
  });

  const [initialization, practices] = await Promise.all([
    scanProjectForInitialization(root),
    scanProjectCodePractices(root),
  ]);

  assert.ok(initialization.discovery?.manifestPaths.includes("package.json"));
  assert.ok(
    initialization.discovery?.manifestPaths.includes(
      "build/custom/package.json",
    ),
  );
  assert.ok("build/custom/package.json" in practices.manifests);
  assert.ok(
    practices.source.representativePaths.includes("build/custom/src/main.ts"),
  );
});

function projectFixture() {
  return {
    ...projectRuntimeFixture(),
    ...generatedOutputFixture(),
  };
}

function projectRuntimeFixture() {
  return {
    "random/client/deep/package.json": JSON.stringify({
      name: "nested-client",
      scripts: { dev: "vite" },
    }),
    "random/client/deep/src/main.ts": "export const application = true",
    "random/server/pyproject.toml": "[project]\nname = 'server'",
    "random/server/poetry.lock": "lock-version = '2.0'",
    "random/server/.env": "DATABASE_PASSWORD=secret",
    "random/server/.env.example": "DATABASE_URL=postgres://localhost/app",
    "random/server/prisma/.env": "DATABASE_URL=postgres://secret",
    "random/server/prisma/schema.prisma":
      'datasource db { provider = "postgresql" }',
    "random/server/ruff.toml": "line-length = 100",
    "random/server/app/main.py": "def application(): return 'ready'",
    "random/server/domain/user_service.py": "def find_user(): return None",
    "random/server/tests/test_users.py": "def test_user(): assert True",
    "random/server/database/migrations/001_create_users.sql":
      "create table users(id integer);",
    "deep/tools/rust/Cargo.toml": "[package]\nname = 'tool'\nversion = '0.1.0'",
    "deep/tools/rust/src/main.rs": "fn main() {}",
    "node_modules/ignored/package.json": JSON.stringify({ name: "ignored" }),
  };
}

function generatedOutputFixture() {
  return {
    "random/server/build/pyproject.toml": "[project]\nname = 'compiled-copy'",
    "random/server/build/ruff.toml": "line-length = 80",
    "random/server/build/domain/user_service.py":
      "def find_user(): return None",
    "random/server/build/tests/test_users.py": "def test_user(): assert True",
    "beginner/build/custom/package.json": JSON.stringify({
      name: "custom-build-project",
    }),
  };
}

function assertManifestDiscovery(
  scan: Awaited<ReturnType<typeof scanProjectForInitialization>>,
) {
  const manifests = scan.discovery?.manifestPaths ?? [];
  assert.ok(manifests.includes("random/client/deep/package.json"));
  assert.ok(manifests.includes("random/server/pyproject.toml"));
  assert.ok(manifests.includes("deep/tools/rust/Cargo.toml"));
  assert.ok(manifests.includes("beginner/build/custom/package.json"));
  assert.equal(manifests.includes("random/server/build/pyproject.toml"), false);
  assert.equal(
    manifests.some((path) => path.includes("node_modules")),
    false,
  );
  assert.equal(
    manifests.some((path) => path.includes("linked-project")),
    false,
  );
}

function assertSafeEvidence(
  scan: Awaited<ReturnType<typeof scanProjectForInitialization>>,
) {
  assert.ok("random/server/.env.example" in scan.files);
  assert.equal("random/server/.env" in scan.files, false);
  assert.equal("random/server/prisma/.env" in scan.files, false);
  assert.ok("random/server/prisma/schema.prisma" in scan.files);
  assert.ok(
    scan.discovery?.lockFilePaths.includes("random/server/poetry.lock"),
  );
  assert.equal("random/server/poetry.lock" in scan.files, false);
}

async function writeProjectFixture(
  root: string,
  files: Record<string, string>,
) {
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }),
  );
}
