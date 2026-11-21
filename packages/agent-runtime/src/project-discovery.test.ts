import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverProjectFiles } from "./project-discovery.js";

// The owner's project held 15 Claude Code worktrees: discovery read 36,172
// files, and the setup evidence quoted their copies of package.json.
test("a linked worktree inside the project is not read; a submodule is", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-discovery-"));
  try {
    const write = async (path: string, text: string) => {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), text);
    };
    await write("package.json", "{}");
    await write(".claude/worktrees/feature-a/.git", `gitdir: ${root}/.git/worktrees/feature-a\n`);
    await write(".claude/worktrees/feature-a/package.json", "{}");
    await write("vendor/lib/.git", "gitdir: ../../.git/modules/vendor/lib\n");
    await write("vendor/lib/package.json", "{}");
    const discovery = await discoverProjectFiles(root);
    assert.ok(discovery.files.includes("package.json"));
    assert.ok(discovery.files.includes("vendor/lib/package.json"), "a submodule is part of the project");
    assert.equal(
      discovery.files.some((path) => path.startsWith(".claude/worktrees/")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
