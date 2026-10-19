import assert from "node:assert/strict";
import test from "node:test";
import { isProjectFolder, samePath } from "./worktree-safety.ts";

test("treats the repository root as a project folder", async () => {
  assert.equal(await isProjectFolder("/code/app", "/code/app/", async () => false), true);
  assert.equal(await isProjectFolder("C:\\Code\\App", "c:/code/app", async () => false), true);
});

test("treats any folder with a .git directory as a project folder", async () => {
  const dirs = new Set(["/code/other/.git"]);
  assert.equal(
    await isProjectFolder("/code/app", "/code/other", async (path) => dirs.has(path)),
    true,
  );
});

test("lets story worktrees be removed", async () => {
  assert.equal(
    await isProjectFolder("/code/app", "/worktrees/app/story-1", async () => false),
    false,
  );
});

test("compares paths without case or trailing slashes", () => {
  assert.equal(samePath("/A/b/", "/a/B"), true);
  assert.equal(samePath("/a/b", "/a/c"), false);
});
