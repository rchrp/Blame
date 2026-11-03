import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  liveStoryEnvFiles,
  prepareStoryEnvFiles,
  worktreeRepositoryRoot,
} from "./env-file-sources.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function projectWithStory(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), "blame-env-live-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  const story = join(base, "story");
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  git(project, "config", "user.email", "test@example.com");
  git(project, "config", "user.name", "Test");
  await writeFile(join(project, ".gitignore"), ".env\n.env.local\n");
  await writeFile(join(project, ".env.development"), "MODE=tracked\n");
  await writeFile(join(project, ".env.example"), "STRIPE_KEY=\n");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "init");
  await writeFile(join(project, ".env"), "SECRET=first\n");
  // Untracked folders that hold env files of their own.
  await mkdir(join(project, "scratch", "copy"), { recursive: true });
  await writeFile(join(project, "scratch", "copy", ".env"), "NO=1\n");
  await mkdir(join(project, ".next", "standalone"), { recursive: true });
  await writeFile(join(project, ".next", "standalone", ".env"), "NO=1\n");
  git(project, "worktree", "add", "-q", "-b", "story", story);
  return { project, story };
}

test("a story reads the project's ignored env files at each start", async (t) => {
  const { project, story } = await projectWithStory(t);
  await prepareStoryEnvFiles(project, story);
  assert.equal(await worktreeRepositoryRoot(story), project);
  assert.equal(await readFile(join(story, ".env"), "utf8"), "SECRET=first\n");

  // The developer edits .env and adds .env.local after the story started.
  await writeFile(join(project, ".env"), "SECRET=second\n");
  await writeFile(join(project, ".env.local"), "LOCAL=yes\n");
  // The story's branch changes a tracked env file: that one is code.
  await writeFile(join(story, ".env.development"), "MODE=story\n");
  await writeFile(join(project, ".env.development"), "MODE=checkout\n");

  // Reading for the Variables tab writes nothing into the story.
  const preview = await liveStoryEnvFiles(story);
  assert.deepEqual(preview.fromProject, [".env.local"]);
  await assert.rejects(() => readFile(join(story, ".env.local")), /ENOENT/);

  const live = await liveStoryEnvFiles(story, { write: true });
  // A worktree on this computer shares .env through a hard link; one in the
  // Blame Runtime gets a copy, refreshed the same way as .env.local here.
  assert.deepEqual(live.fromProject, [".env.local"]);
  assert.deepEqual(
    Object.fromEntries(live.files.map(({ path, content }) => [path, content])),
    {
      ".env": "SECRET=second\n",
      ".env.development": "MODE=story\n",
      ".env.example": "STRIPE_KEY=\n",
      ".env.local": "LOCAL=yes\n",
    },
  );
  // Nothing changed since: nothing to copy again.
  assert.deepEqual((await liveStoryEnvFiles(story)).fromProject, []);
  // The project itself was never written to.
  assert.equal(
    await readFile(join(project, ".env"), "utf8"),
    "SECRET=second\n",
  );
});

test("finds the project of a worktree created before Blame recorded it", async (t) => {
  const { project, story } = await projectWithStory(t);
  const { realpath } = await import("node:fs/promises");
  assert.equal(await worktreeRepositoryRoot(story), await realpath(project));
});
