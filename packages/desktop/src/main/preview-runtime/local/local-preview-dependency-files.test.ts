import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  findProjectFilesByName,
  joinWorkspacePath,
  readExistingFiles,
  run,
} from "../../workspace-runtime.ts";
import {
  dependencyInputs,
  dependencyManifestFiles,
} from "./local-preview-dependency-files.ts";

const plan = { setup: [] };

async function worktree(
  t: TestContext,
  files: Record<string, string> = {},
): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "blame-deps-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const all: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "root",
      scripts: { dev: "vite", build: "vite build" },
      dependencies: { ms: "2.1.3" },
    }),
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    "apps/web/package.json": JSON.stringify({ name: "web" }),
    "apps/web/package-lock.json": "{}",
    // Folders no search looks into.
    "apps/web/node_modules/dep/package.json": JSON.stringify({
      scripts: { postinstall: "node build.js" },
    }),
    ".nuxt/package.json": "{ not json",
    ...files,
  };
  for (const [file, content] of Object.entries(all)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}

// The key as it was computed before shared setup: it must not change, or
// every existing node_modules volume would be orphaned.
async function legacyKey(root: string) {
  const manifests = await findProjectFilesByName(root, "package.json", {
    run: (command, args) => run(command, args, { cwd: root }),
  });
  const paths = new Map<string, string>();
  for (const file of dependencyManifestFiles)
    paths.set(joinWorkspacePath(root, file), file);
  for (const path of manifests) paths.set(path, path.slice(root.length + 1));
  const contents = await readExistingFiles([...paths.keys()]);
  const hash = createHash("sha256");
  const inputs = [...paths]
    .flatMap(([path, file]) =>
      typeof contents[path] === "string"
        ? [{ file, content: contents[path] as string }]
        : [],
    )
    .sort((left, right) => left.file.localeCompare(right.file));
  if (!inputs.length) hash.update(JSON.stringify(plan.setup));
  for (const { file, content } of inputs)
    hash.update(file).update("\0").update(content).update("\0");
  return hash.digest("hex").slice(0, 12);
}

test("the dependency key is the one volumes were already named with", async (t) => {
  const root = await worktree(t);
  assert.equal((await dependencyInputs(root, plan)).key, await legacyKey(root));
  const empty = await realpath(await mkdtemp(join(tmpdir(), "blame-deps-")));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.equal(
    (await dependencyInputs(empty, { setup: [] })).key,
    await legacyKey(empty),
  );
});

test("an install is shared when nothing it reads differs between stories", async (t) => {
  const first = await dependencyInputs(await worktree(t), plan);
  const second = await dependencyInputs(await worktree(t), plan);
  assert.equal(typeof first.sharedInstall, "string");
  assert.equal(first.sharedInstall, second.sharedInstall);
  assert.equal(first.key, second.key);
});

test("a nested lockfile or a package manager setting the key misses changes the shared inputs", async (t) => {
  const base = await dependencyInputs(await worktree(t), plan);
  const nested = await dependencyInputs(
    await worktree(t, {
      "apps/web/package-lock.json": '{"lockfileVersion":3}',
    }),
    plan,
  );
  assert.equal(nested.key, base.key, "the key only reads root lockfiles");
  assert.notEqual(nested.sharedInstall, base.sharedInstall);
  for (const config of [
    ".npmrc",
    "apps/web/.npmrc",
    ".pnpmfile.cjs",
    "bunfig.toml",
  ]) {
    const changed = await dependencyInputs(
      await worktree(t, { [config]: "node-linker=hoisted\n" }),
      plan,
    );
    assert.equal(changed.key, base.key, config);
    assert.notEqual(changed.sharedInstall, base.sharedInstall, config);
  }
  const root = await dependencyInputs(
    await worktree(t, { "pnpm-lock.yaml": "lockfileVersion: 10\n" }),
    plan,
  );
  assert.notEqual(root.key, base.key);
  assert.notEqual(root.sharedInstall, base.sharedInstall);
});

for (const [name, files] of [
  [
    "a postinstall script",
    {
      "package.json": JSON.stringify({
        scripts: { postinstall: "nuxt prepare" },
      }),
    },
  ],
  [
    "a prepare script in a nested package",
    {
      "apps/web/package.json": JSON.stringify({
        scripts: { prepare: "husky" },
      }),
    },
  ],
  [
    "a preinstall script",
    {
      "package.json": JSON.stringify({ scripts: { preinstall: "node x.js" } }),
    },
  ],
  [
    "a dependency that is a folder of the worktree",
    {
      "apps/web/package.json": JSON.stringify({
        dependencies: { local: "file:../../packages/local" },
      }),
    },
  ],
  [
    "an override that links a folder",
    {
      "package.json": JSON.stringify({
        pnpm: { overrides: { left: "link:./vendor/left" } },
      }),
    },
  ],
  ["a manifest that does not parse", { "apps/web/package.json": "{ nope" }],
  [
    "a Yarn release kept in the repository",
    { ".yarnrc.yml": "yarnPath: .yarn/releases/yarn-4.0.0.cjs\n" },
  ],
] as const) {
  test(`an install is not shared with ${name}`, async (t) => {
    const inputs = await dependencyInputs(await worktree(t, files), plan);
    assert.equal(inputs.sharedInstall, undefined);
    assert.equal(typeof inputs.key, "string", "the key still names volumes");
  });
}

test("an install is not shared when the search for manifests failed or found none", async (t) => {
  const missing = join(tmpdir(), "blame-deps-does-not-exist");
  const failed = await dependencyInputs(missing, plan);
  assert.equal(failed.sharedInstall, undefined);
  assert.equal(typeof failed.key, "string");
  const empty = await realpath(await mkdtemp(join(tmpdir(), "blame-deps-")));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.equal((await dependencyInputs(empty, plan)).sharedInstall, undefined);
});
