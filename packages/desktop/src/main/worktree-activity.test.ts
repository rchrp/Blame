import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WorktreeActivity } from "./worktree-activity.ts";
import { WorktreeLogs } from "./worktree-logs.ts";
import {
  storyWorktreeAddArguments,
  storyWorktreeRemoveArguments,
} from "./workspace-git.ts";

test("removes a locked Git worktree only after preparation settles, without late log resurrection", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "blame removal [test] & ")),
  );
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  const repository = join(root, "repository");
  const worktree = join(root, "story-US-001");
  await mkdir(repository);
  const git = (...args: string[]) =>
    promisify(execFile)("git", ["-C", repository, ...args]);
  await git("init");
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@blame.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  await git(
    ...storyWorktreeAddArguments({
      branch: "blame/story-US-001",
      existing: false,
      worktree,
    }),
  );
  const activity = new WorktreeActivity();
  const logs = new WorktreeLogs(activity);
  const release = Promise.withResolvers<void>();
  const preparation = activity.run(worktree, async () => {
    await release.promise;
    await mkdir(join(worktree, ".blame", "preview"), { recursive: true });
    await writeFile(join(worktree, ".blame", "preview", "state"), "prepared");
  });
  const logWrite = logs.section(worktree, "already writing");
  logs.append(worktree, "queued before deletion");
  let settled = false;
  const closing = activity.close(worktree).then(() => {
    settled = true;
  });
  logs.discard(worktree);
  await logWrite;
  assert.equal(settled, false);
  assert.match(
    await readFile(join(worktree, ".blame", "logs", "setup.log"), "utf8"),
    /already writing/,
  );
  await assert.rejects(
    activity.run(worktree, async () => {
      assert.fail("A new preview must not start during removal");
    }),
    /being removed/,
  );
  release.resolve();
  await preparation;
  await closing;
  await git(...storyWorktreeRemoveArguments(worktree));

  // Timer output, recovery and detached timing callbacks used to recreate
  // .blame/logs after Git had successfully deleted the worktree.
  logs.append(worktree, "late output");
  await logs.flush();
  await logs.recovery(worktree, "late recovery");
  await logs.timing(worktree, "late setup", 1);
  await assert.rejects(stat(worktree), { code: "ENOENT" });
  assert.doesNotMatch(
    (await git("worktree", "list", "--porcelain")).stdout,
    /story-US-001/,
  );
  assert.ok((await stat(join(repository, ".git"))).isDirectory());

  // An explicit requeue can recreate the same story after cleanup. Buffered
  // output from the old execution must not leak into that new worktree.
  activity.open(worktree);
  await git(
    ...storyWorktreeAddArguments({
      branch: "blame/story-US-001",
      existing: true,
      worktree,
    }),
  );
  await logs.section(worktree, "new run");
  await logs.flush();
  assert.equal(
    await readFile(join(worktree, ".blame", "logs", "setup.log"), "utf8"),
    "\n[new run]\n",
  );
});

test("a failing preparation settles removal without reopening the worktree or blocking another project", async () => {
  const activity = new WorktreeActivity();
  const release = Promise.withResolvers<void>();
  const running = activity.run("first", async () => {
    await release.promise;
    throw new Error("Setup failed");
  });
  const failure = assert.rejects(running, /Setup failed/);
  const closing = activity.close("first");
  assert.throws(() => activity.open("first"), /still finishing/);
  assert.equal(
    await activity.run("second", async () => "unaffected"),
    "unaffected",
  );
  release.resolve();
  await failure;
  await closing;
  await assert.rejects(
    activity.run("first", async () => undefined),
    /removed/,
  );
  activity.open("first");
  assert.equal(await activity.run("first", async () => "ready"), "ready");
});
