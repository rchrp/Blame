import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import {
  ensureGitRepository,
  gitDiffBetween,
  gitDiffStatsBetween,
  gitDiffFrom,
  gitLogArguments,
  storyWorktreeAddArguments,
  storyWorktreeRemoveArguments,
  gitSnapshot,
  isGitRepository,
  listGitDirectory,
  readGitFile,
} from "./workspace-git.ts";
import { workspaceDiffStats } from "./workspace-diff-stats.ts";
import {
  gitBranches,
  gitTrackRemoteBranch,
} from "./workspaces/workspace-git-branches.ts";

const execFileAsync = promisify(execFile);

test("totals textual and binary numstat changes", () => {
  assert.deepEqual(
    workspaceDiffStats(
      "12\t4\tsrc/app.ts\n-\t-\tassets/logo.png\n3\t2\t.blame/log.txt\n",
    ),
    { additions: 12, deletions: 4, files: 2 },
  );
});

test("managed story registrations survive host pruning and can still be intentionally removed", async () => {
  const repository = await createRepository();
  const worktree = join(repository, "runtime-story");
  try {
    await git(
      repository,
      storyWorktreeAddArguments({
        branch: "story/vm",
        existing: false,
        startPoint: "HEAD",
        worktree,
      }),
    );
    await rename(worktree, join(repository, "vm-storage"));
    await git(repository, ["worktree", "prune", "--expire=now"]);
    const retained = (
      await git(repository, ["worktree", "list", "--porcelain"])
    ).stdout;
    assert.ok(retained.includes(worktree));
    assert.match(retained, /locked Managed by Blame/);
    await git(repository, storyWorktreeRemoveArguments(worktree));
    assert.ok(
      !(
        await git(repository, ["worktree", "list", "--porcelain"])
      ).stdout.includes(worktree),
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("reads a merged story from Git history", async () => {
  const repository = await createRepository();
  try {
    const base = await revision(repository);
    await unlink(join(repository, "removed.txt"));
    await rm(join(repository, "removed"), { recursive: true });
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src", "added.txt"), "added\n");
    await commit(repository, "story");
    const merge = await revision(repository);

    const diff = await gitDiffBetween({
      from: base,
      root: repository,
      to: merge,
    });
    const stats = await gitDiffStatsBetween({
      from: base,
      root: repository,
      to: merge,
    });
    const entries = await listGitDirectory({
      refs: [merge, base],
      root: repository,
    });
    const removed = await readGitFile({
      path: "removed.txt",
      refs: [merge, base],
      root: repository,
    });
    const removedDirectory = await listGitDirectory({
      path: "removed",
      refs: [merge, base],
      root: repository,
    });

    assert.match(diff, /removed\.txt/);
    assert.match(diff, /src\/added\.txt/);
    assert.equal(stats.files, 3);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["removed", "src", "removed.txt"],
    );
    assert.deepEqual(
      removedDirectory.map((entry) => entry.name),
      ["nested.txt"],
    );
    assert.equal(removed, "removed\n");
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("excludes Blame-managed files from historical diffs and stats", async () => {
  const repository = await createRepository();
  try {
    await mkdir(join(repository, ".blame"));
    await writeFile(join(repository, ".blame", "log.txt"), "base\n");
    await commit(repository, "Blame state");
    const base = await revision(repository);

    await writeFile(join(repository, ".blame", "log.txt"), "changed\n");
    await writeFile(join(repository, "visible.txt"), "visible\n");
    await commit(repository, "visible change");
    const change = await revision(repository);

    const diff = await gitDiffBetween({
      from: base,
      root: repository,
      to: change,
    });
    const stats = await gitDiffStatsBetween({
      from: base,
      root: repository,
      to: change,
    });

    assert.doesNotMatch(diff, /\.blame/);
    assert.match(diff, /visible\.txt/);
    assert.deepEqual(stats, { additions: 1, deletions: 0, files: 1 });
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("excludes runtime env files from Git history diffs", async () => {
  const repository = await createRepository();
  try {
    const base = await revision(repository);
    await writeFile(join(repository, ".env.test"), "DATABASE_URL=test\n");
    await writeFile(join(repository, ".env.example"), "DATABASE_URL=\n");
    await commit(repository, "env files");
    const merge = await revision(repository);

    const diff = await gitDiffBetween({
      from: base,
      root: repository,
      to: merge,
    });

    assert.doesNotMatch(diff, /\.env\.test/);
    assert.match(diff, /\.env\.example/);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("compares a checkpoint revision with the current worktree", async () => {
  const repository = await createRepository();
  try {
    const checkpoint = await revision(repository);
    await writeFile(join(repository, "removed.txt"), "changed\n");
    await writeFile(join(repository, "untracked.txt"), "untracked\n");
    await mkdir(join(repository, ".blame"));
    await writeFile(join(repository, ".blame", "log.txt"), "internal\n");

    const diff = await gitDiffFrom({ from: checkpoint, root: repository });

    assert.match(diff, /removed\.txt/);
    assert.match(diff, /-removed/);
    assert.match(diff, /\+changed/);
    assert.match(diff, /untracked\.txt/);
    assert.doesNotMatch(diff, /\.blame/);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("story review resolves the current checkout rather than another branch's latest commit", async () => {
  const repository = await createRepository();
  try {
    const base = await revision(repository);
    await git(repository, ["switch", "-c", "story/committed"]);
    await writeFile(join(repository, "story.txt"), "already committed\n");
    await commit(repository, "story awaiting merge");
    const storyHead = await revision(repository);
    await git(repository, ["checkout", "--detach", base]);
    const current = await git(
      repository,
      gitLogArguments({ currentBranchOnly: true, limit: 1 }),
    );
    assert.equal(current.stdout.split("\x1f")[0], base);
    assert.doesNotMatch(current.stdout, new RegExp(storyHead));
    const all = await git(repository, gitLogArguments({}));
    assert.match(all.stdout, new RegExp(storyHead));
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("captures an immutable worktree snapshot including untracked files", async () => {
  const repository = await createRepository();
  try {
    const base = await revision(repository);
    await writeFile(join(repository, "removed.txt"), "first snapshot\n");
    await writeFile(join(repository, "untracked.txt"), "captured\n");
    const snapshot = await gitSnapshot({ id: "run-1", root: repository });
    await writeFile(join(repository, "removed.txt"), "later change\n");
    await writeFile(join(repository, "later.txt"), "not captured\n");

    const diff = await gitDiffBetween({
      from: base,
      root: repository,
      to: snapshot,
    });

    assert.match(diff, /first snapshot/);
    assert.match(diff, /untracked\.txt/);
    assert.doesNotMatch(diff, /later change/);
    assert.doesNotMatch(diff, /later\.txt/);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("captures staged changes and unstaged deletions from the final worktree state", async () => {
  const repository = await createRepository();
  try {
    await writeFile(join(repository, "staged.txt"), "base\n");
    await writeFile(join(repository, "unstaged.txt"), "base\n");
    await commit(repository, "snapshot fixture");
    const base = await revision(repository);
    await writeFile(join(repository, "staged.txt"), "staged version\n");
    await git(repository, ["add", "staged.txt"]);
    await writeFile(join(repository, "staged.txt"), "worktree version\n");
    await unlink(join(repository, "unstaged.txt"));

    const snapshot = await gitSnapshot({ id: "run-states", root: repository });
    const diff = await gitDiffBetween({
      from: base,
      root: repository,
      to: snapshot,
    });

    assert.match(diff, /worktree version/);
    assert.doesNotMatch(diff, /staged version/);
    assert.match(diff, /unstaged\.txt/);
    assert.match(diff, /deleted file mode/);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("excludes runtime env files from captured snapshots", async () => {
  const repository = await createRepository();
  try {
    const base = await revision(repository);
    await writeFile(join(repository, ".env.local"), "TOKEN=secret\n");
    await writeFile(join(repository, ".env.example"), "TOKEN=\n");

    const snapshot = await gitSnapshot({ id: "run-2", root: repository });
    const diff = await gitDiffBetween({
      from: base,
      root: repository,
      to: snapshot,
    });
    const { stdout: snapshotFiles } = await git(repository, [
      "ls-tree",
      "-r",
      "--name-only",
      snapshot,
    ]);

    assert.doesNotMatch(diff, /TOKEN=secret/);
    assert.doesNotMatch(diff, /\.env\.local/);
    assert.match(diff, /\.env\.example/);
    assert.doesNotMatch(snapshotFiles, /\.env\.local/);
    assert.match(snapshotFiles, /\.env\.example/);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("excludes runtime env files from checkpoint worktree diffs", async () => {
  const repository = await createRepository();
  try {
    const checkpoint = await revision(repository);
    await writeFile(join(repository, ".env.local"), "TOKEN=secret\n");
    await writeFile(join(repository, ".env.example"), "TOKEN=\n");

    const diff = await gitDiffFrom({ from: checkpoint, root: repository });

    assert.doesNotMatch(diff, /TOKEN=secret/);
    assert.doesNotMatch(diff, /\.env\.local/);
    assert.match(diff, /\.env\.example/);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("excludes staged runtime env files from checkpoint worktree diffs", async () => {
  const repository = await createRepository();
  try {
    const checkpoint = await revision(repository);
    await writeFile(join(repository, ".env.local"), "TOKEN=secret\n");
    await writeFile(join(repository, ".env.example"), "TOKEN=\n");
    await git(repository, ["add", ".env.local", ".env.example"]);

    const diff = await gitDiffFrom({ from: checkpoint, root: repository });

    assert.doesNotMatch(diff, /TOKEN=secret/);
    assert.doesNotMatch(diff, /\.env\.local/);
    assert.match(diff, /\.env\.example/);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("rejects unsafe Git history inputs", async () => {
  const repository = await createRepository();
  try {
    const ref = await revision(repository);
    await assert.rejects(
      listGitDirectory({ path: "../outside", refs: [ref], root: repository }),
      /Path escapes workspace/,
    );
    await assert.rejects(
      readGitFile({ path: "removed.txt", refs: ["--help"], root: repository }),
      /Invalid Git revision/,
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("initializes an opened folder that only belongs to a parent repository", async () => {
  const parentRepository = await createRepository();
  const openedFolder = join(parentRepository, "opened-project");
  try {
    await mkdir(openedFolder);
    await writeFile(
      join(openedFolder, "package.json"),
      '{"name":"opened-project"}\n',
    );

    assert.equal(await isGitRepository(openedFolder), false);
    assert.equal(await ensureGitRepository(openedFolder), true);

    const { stdout } = await git(openedFolder, [
      "rev-parse",
      "--show-toplevel",
    ]);
    assert.equal(stdout.trim(), await realpath(openedFolder));
    assert.equal(await isGitRepository(openedFolder), true);
  } finally {
    await rm(parentRepository, { force: true, recursive: true });
  }
});

test("keeps an existing repository unchanged", async () => {
  const repository = await createRepository();
  try {
    assert.equal(await ensureGitRepository(repository), false);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("a new story worktree starts from its target branch's last commit, without uncommitted changes", async () => {
  const repository = await createRepository();
  const worktree = join(repository, "story-from-release");
  try {
    await git(repository, ["branch", "release"]);
    const releaseCommit = await revision(repository);
    await writeFile(join(repository, "head-only.txt"), "head\n");
    await commit(repository, "ahead of release");
    await writeFile(join(repository, "removed.txt"), "uncommitted\n");
    await git(
      repository,
      storyWorktreeAddArguments({
        branch: "story/release",
        existing: false,
        startPoint: "release",
        worktree,
      }),
    );
    assert.equal(await revision(worktree), releaseCommit);
    assert.equal((await git(worktree, ["status", "--porcelain"])).stdout, "");
    await git(repository, storyWorktreeRemoveArguments(worktree));
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
test("lists remote-only branches and tracks one with a new local branch", async () => {
  const repository = await createRepository();
  const remote = `${repository}-remote.git`;
  try {
    await git(repository, ["init", "--bare", remote]);
    await git(repository, ["remote", "add", "origin", remote]);
    const current = (
      await git(repository, ["branch", "--show-current"])
    ).stdout.trim();
    await git(repository, ["push", "--set-upstream", "origin", current]);
    await git(repository, [
      "push",
      "origin",
      `${current}:refs/heads/feature/remote`,
    ]);
    await git(repository, ["fetch", "origin"]);

    assert.deepEqual(await gitBranches(repository), {
      current,
      local: [current],
      remote: ["origin/feature/remote"],
    });
    assert.deepEqual(
      await gitTrackRemoteBranch({
        remoteBranch: "origin/feature/remote",
        root: repository,
      }),
      { branch: "feature/remote" },
    );
    assert.equal(
      (
        await git(repository, ["rev-parse", "--abbrev-ref", "feature/remote@{u}"])
      ).stdout.trim(),
      "origin/feature/remote",
    );
    assert.deepEqual((await gitBranches(repository)).remote, []);
    await assert.rejects(
      gitTrackRemoteBranch({
        remoteBranch: "--upload-pack=touch",
        root: repository,
      }),
      /Invalid Git branch name/,
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});
async function createRepository() {
  const repository = await mkdtemp(join(tmpdir(), "blame-workspace-git-"));
  await git(repository, ["init"]);
  await git(repository, ["config", "user.email", "test@blame.local"]);
  await git(repository, ["config", "user.name", "Blame Test"]);
  await writeFile(join(repository, "removed.txt"), "removed\n");
  await mkdir(join(repository, "removed"));
  await writeFile(join(repository, "removed", "nested.txt"), "nested\n");
  await commit(repository, "base");
  return repository;
}

async function commit(repository: string, message: string) {
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", message]);
}

async function revision(repository: string) {
  const { stdout } = await git(repository, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

function git(repository: string, args: string[]) {
  return execFileAsync("git", args, { cwd: repository });
}
