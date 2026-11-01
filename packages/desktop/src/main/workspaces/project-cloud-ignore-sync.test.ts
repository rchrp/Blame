import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { syncProjectCloudIgnore } from "./project-cloud-ignore-sync.ts";

const run = promisify(execFile);

test("a story gets the cloud exclusions its project keeps out of Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-cloud-ignore-"));
  const project = join(root, "project");
  const story = join(root, "story");
  const git = (cwd: string, ...args: string[]) =>
    run("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  try {
    await run("git", ["init", "--quiet", project]);
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, "add", "README.md");
    await git(project, "commit", "--quiet", "-m", "init");
    // Written by the analysis, never committed (JuliettePortfolio, 2026-11-01).
    await writeFile(join(project, ".blameignore"), "/docs/**\n");
    await git(project, "worktree", "add", "--quiet", "-b", "story", story);

    assert.equal(await syncProjectCloudIgnore(story), true);
    assert.equal(
      await readFile(join(story, ".blameignore"), "utf8"),
      "/docs/**\n",
    );
    // The story's diff stays clean.
    const { stdout } = await git(story, "status", "--porcelain");
    assert.equal(stdout, "");
    // Nothing to do once it matches; a changed project file is refreshed.
    assert.equal(await syncProjectCloudIgnore(story), false);
    await writeFile(join(project, ".blameignore"), "/docs/**\n/media/**\n");
    assert.equal(await syncProjectCloudIgnore(story), true);
    assert.match(await readFile(join(story, ".blameignore"), "utf8"), /media/);

    // A story that tracks its own .blameignore keeps it.
    await writeFile(join(story, ".blameignore"), "/story-only/**\n");
    await git(story, "add", "-f", ".blameignore");
    await git(story, "commit", "--quiet", "-m", "own rules");
    assert.equal(await syncProjectCloudIgnore(story), false);
    assert.equal(
      await readFile(join(story, ".blameignore"), "utf8"),
      "/story-only/**\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
