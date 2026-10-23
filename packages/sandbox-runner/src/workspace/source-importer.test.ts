import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  cloneCanonicalBundle,
  pruneReconstructedClone,
} from "./source-importer.js";

const execFileAsync = promisify(execFile);

test("clones the canonical main branch independently of Git defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-source-bundle-"));
  const repository = join(root, "repository");
  const bundle = join(root, "repository.bundle");
  const checkout = join(root, "checkout");
  const previousGitConfig = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
  };
  try {
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "init.defaultBranch";
    process.env.GIT_CONFIG_VALUE_0 = "master";
    await mkdir(repository);
    await git(repository, ["init", "--quiet", "--initial-branch=main"]);
    await git(repository, ["config", "user.name", "Blame"]);
    await git(repository, ["config", "user.email", "preview@blame.local"]);
    await writeFile(join(repository, "README.md"), "canonical\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "--quiet", "-m", "canonical"]);
    await git(repository, ["bundle", "create", bundle, "refs/heads/main"]);
    await cloneCanonicalBundle(bundle, checkout);
    assert.equal(
      await readFile(join(checkout, "README.md"), "utf8"),
      "canonical\n",
    );
  } finally {
    restoreEnvironment("GIT_CONFIG_COUNT", previousGitConfig.count);
    restoreEnvironment("GIT_CONFIG_KEY_0", previousGitConfig.key);
    restoreEnvironment("GIT_CONFIG_VALUE_0", previousGitConfig.value);
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline reconstruction preserves every file from the canonical checkout", async () => {
  const root = await fixture();
  try {
    await pruneReconstructedClone(root, [], true);
    assert.equal(
      await readFile(join(root, "README.md"), "utf8"),
      "canonical\n",
    );
    assert.equal(
      await readFile(join(root, "src/index.ts"), "utf8"),
      "export {}\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full reconstruction still prunes canonical files deleted by the workspace", async () => {
  const root = await fixture();
  try {
    await pruneReconstructedClone(root, ["src/index.ts"], false);
    await assert.rejects(readFile(join(root, "README.md")), { code: "ENOENT" });
    assert.equal(
      await readFile(join(root, "src/index.ts"), "utf8"),
      "export {}\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gitignore-v1 reconstruction keeps committed files the rule skips", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, ".gitignore"), "vendor/\n");
    await mkdir(join(root, "vendor"));
    await writeFile(join(root, "vendor/lib.js"), "committed\n");
    await pruneReconstructedClone(
      root,
      [".gitignore", "src/index.ts"],
      false,
      "gitignore-v1",
    );
    assert.equal(
      await readFile(join(root, "vendor/lib.js"), "utf8"),
      "committed\n",
    );
    await assert.rejects(readFile(join(root, "README.md")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "blame-source-importer-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "README.md"), "canonical\n");
  await writeFile(join(root, "src/index.ts"), "export {}\n");
  return root;
}

async function git(root: string, args: string[]) {
  await execFileAsync("git", ["-C", root, ...args]);
}

function restoreEnvironment(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
