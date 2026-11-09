import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ClineCoreStartInput } from "@cline/sdk";

import { BlameAgentRuntime } from "./cline-runtime.js";

const execFileAsync = promisify(execFile);

test("merges into a dirty target branch and restores its local changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blame-approve-merge-"));
  const repositoryRoot = join(directory, "repository");
  const worktree = join(directory, "story-worktree");

  try {
    await mkdir(repositoryRoot);
    await git(repositoryRoot, ["init", "--initial-branch=main"]);
    await git(repositoryRoot, ["config", "user.email", "blame@example.com"]);
    await git(repositoryRoot, ["config", "user.name", "Blame Test"]);
    await writeFile(
      join(repositoryRoot, "shared.txt"),
      "alpha\nbeta\ngamma\ndelta\nepsilon\n",
    );
    await writeFile(join(repositoryRoot, "unstaged.txt"), "base\n");
    await writeFile(join(repositoryRoot, "existing.txt"), "base\n");
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "-m", "initial"]);
    const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);

    await git(repositoryRoot, [
      "worktree",
      "add",
      "-b",
      "story/test-dirty-target",
      worktree,
      "main",
    ]);
    await writeFile(
      join(worktree, "shared.txt"),
      "alpha\nbeta\ngamma\ndelta\nstory epsilon\n",
    );
    await git(worktree, ["add", "shared.txt"]);
    await git(worktree, ["commit", "-m", "story change"]);
    const storyCommit = await git(worktree, ["rev-parse", "HEAD"]);

    await writeFile(join(repositoryRoot, "existing.txt"), "existing stash\n");
    await writeFile(join(repositoryRoot, "existing-untracked.txt"), "saved\n");
    await git(repositoryRoot, [
      "stash",
      "push",
      "--include-untracked",
      "--message",
      "pre-existing stash",
    ]);

    await writeFile(
      join(repositoryRoot, "shared.txt"),
      "local alpha\nbeta\ngamma\ndelta\nepsilon\n",
    );
    await git(repositoryRoot, ["add", "shared.txt"]);
    await writeFile(join(repositoryRoot, "unstaged.txt"), "local unstaged\n");
    await writeFile(join(repositoryRoot, "local-untracked.txt"), "local\n");
    await writeFile(
      join(repositoryRoot, "local-staged-deleted.txt"),
      "staged archive\n",
    );
    await git(repositoryRoot, ["add", "local-staged-deleted.txt"]);
    await unlink(join(repositoryRoot, "local-staged-deleted.txt"));

    const runtime = new BlameAgentRuntime();
    const result = await runtime.approveAndMerge({
      apiConnection: { url: "https://api.example" },
      modelId: "test-model",
      providerId: "test-provider",
      repositoryRoot,
      storyBranch: "story/test-dirty-target",
      targetBranch: "main",
      summary: "Exercise merging with local target-branch changes.",
      title: "Dirty target merge",
      push: true,
      worktree,
    });

    assert.deepEqual(result, {
      baseCommit,
      mergeCommit: storyCommit,
      push: { status: "no-upstream", remote: null },
      targetBranch: "main",
    });
    assert.equal(await git(repositoryRoot, ["rev-parse", "HEAD"]), storyCommit);
    assert.equal(
      await readFile(join(repositoryRoot, "shared.txt"), "utf8"),
      "local alpha\nbeta\ngamma\ndelta\nstory epsilon\n",
    );
    assert.equal(
      await readFile(join(repositoryRoot, "unstaged.txt"), "utf8"),
      "local unstaged\n",
    );
    assert.equal(
      await readFile(join(repositoryRoot, "local-untracked.txt"), "utf8"),
      "local\n",
    );
    assert.equal(
      await git(repositoryRoot, ["status", "--porcelain"]),
      [
        "AD local-staged-deleted.txt",
        "M  shared.txt",
        " M unstaged.txt",
        "?? local-untracked.txt",
      ].join("\n"),
    );
    assert.equal(
      await git(repositoryRoot, ["show", ":local-staged-deleted.txt"]),
      "staged archive",
    );
    await assert.rejects(
      readFile(join(repositoryRoot, "local-staged-deleted.txt")),
      { code: "ENOENT" },
    );
    assert.match(
      await git(repositoryRoot, ["stash", "list", "--format=%gs"]),
      /^On main: pre-existing stash$/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("leaves the target branch unchanged when local changes truly conflict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blame-approve-conflict-"));
  const repositoryRoot = join(directory, "repository");
  const worktree = join(directory, "story-worktree");

  try {
    await mkdir(repositoryRoot);
    await git(repositoryRoot, ["init", "--initial-branch=main"]);
    await git(repositoryRoot, ["config", "user.email", "blame@example.com"]);
    await git(repositoryRoot, ["config", "user.name", "Blame Test"]);
    await writeFile(join(repositoryRoot, "shared.txt"), "base\n");
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "-m", "initial"]);
    const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);

    await git(repositoryRoot, [
      "worktree",
      "add",
      "-b",
      "story/test-conflicting-target",
      worktree,
      "main",
    ]);
    await writeFile(join(worktree, "shared.txt"), "story\n");
    await git(worktree, ["add", "shared.txt"]);
    await git(worktree, ["commit", "-m", "story change"]);
    await writeFile(join(repositoryRoot, "shared.txt"), "local\n");

    const runtime = new BlameAgentRuntime();
    await assert.rejects(
      runtime.approveAndMerge({
        apiConnection: { url: "https://api.example" },
        modelId: "test-model",
        providerId: "test-provider",
        repositoryRoot,
        storyBranch: "story/test-conflicting-target",
        summary: "Exercise a real local conflict.",
        title: "Conflicting target merge",
        worktree,
      }),
      /conflict with local target-branch changes/,
    );

    assert.equal(await git(repositoryRoot, ["rev-parse", "HEAD"]), baseCommit);
    assert.equal(
      await readFile(join(repositoryRoot, "shared.txt"), "utf8"),
      "local\n",
    );
    assert.equal(
      await git(repositoryRoot, ["status", "--porcelain"]),
      "M shared.txt",
    );
    assert.equal(
      await git(repositoryRoot, ["stash", "list", "--format=%gs"]),
      "",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("merges a VM story through host credentials and preserves unpublished target commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blame-approve-host-"));
  const repositoryRoot = join(directory, "project");
  const worktree = join(directory, "vm-story");
  const remote = join(directory, "remote.git");
  const fetches: string[] = [];
  try {
    await mkdir(repositoryRoot);
    await git(directory, ["init", "--bare", remote]);
    await git(repositoryRoot, ["init", "--initial-branch=main"]);
    await git(repositoryRoot, ["config", "user.email", "blame@example.com"]);
    await git(repositoryRoot, ["config", "user.name", "Blame Test"]);
    await writeFile(join(repositoryRoot, "base.txt"), "base\n");
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "-m", "initial"]);
    await git(repositoryRoot, ["remote", "add", "origin", remote]);
    await git(repositoryRoot, ["push", "--set-upstream", "origin", "main"]);
    await git(repositoryRoot, [
      "worktree",
      "add",
      "-b",
      "story/retry",
      worktree,
    ]);
    await writeFile(join(worktree, "story.txt"), "approved story\n");
    await git(worktree, ["add", "."]);
    await git(worktree, [
      "commit",
      "-m",
      "story already committed before retry",
    ]);
    await writeFile(
      join(repositoryRoot, "local.txt"),
      "unpublished target work\n",
    );
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "-m", "local target commit"]);
    const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const runtime = new BlameAgentRuntime(undefined, {
      git: async (cwd, args) => {
        if (args[0] === "fetch" || args[0] === "push") {
          assert.equal(
            cwd,
            repositoryRoot,
            "remote credentials exist only on the host",
          );
          if (args[0] === "fetch") fetches.push(cwd);
        }
        return git(cwd, args);
      },
    });
    const result = await runtime.approveAndMerge({
      apiConnection: { url: "https://api.example" },
      modelId: "test-model",
      providerId: "test-provider",
      repositoryRoot,
      worktree,
      storyBranch: "story/retry",
      push: true,
      title: "Resume a committed VM story",
      summary: "Finish approval without giving the VM remote credentials.",
    });
    assert.equal(result.baseCommit, baseCommit);
    assert.equal(result.targetBranch, "main");
    assert.equal(
      await git(repositoryRoot, ["rev-parse", "HEAD"]),
      result.mergeCommit,
    );
    assert.equal(await git(remote, ["rev-parse", "main"]), result.mergeCommit);
    assert.equal(
      await readFile(join(repositoryRoot, "local.txt"), "utf8"),
      "unpublished target work\n",
    );
    assert.equal(
      await readFile(join(repositoryRoot, "story.txt"), "utf8"),
      "approved story\n",
    );
    assert.deepEqual(fetches, [repositoryRoot]);
  } finally {
    new BlameAgentRuntime(undefined, { git });
    await rm(directory, { recursive: true, force: true });
  }
});

test("early merge failures clean only their temporary checkout and retain VM registrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blame-merge-prune-"));
  const repositoryRoot = join(directory, "project");
  const worktree = join(directory, "story");
  const vmWorktree = join(directory, "vm-only");
  const remote = join(directory, "remote.git");
  try {
    await mkdir(repositoryRoot);
    await git(directory, ["init", "--bare", remote]);
    await git(repositoryRoot, ["init", "--initial-branch=main"]);
    await git(repositoryRoot, ["config", "user.email", "blame@example.com"]);
    await git(repositoryRoot, ["config", "user.name", "Blame Test"]);
    await writeFile(join(repositoryRoot, "base.txt"), "base\n");
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["commit", "-m", "initial"]);
    await git(repositoryRoot, ["remote", "add", "origin", remote]);
    await git(repositoryRoot, ["push", "--set-upstream", "origin", "main"]);
    await git(repositoryRoot, [
      "worktree",
      "add",
      "-b",
      "story/review",
      worktree,
    ]);
    await git(repositoryRoot, [
      "worktree",
      "add",
      "-b",
      "story/vm",
      vmWorktree,
    ]);
    // The host cannot see the VM's .git file, but its shared registration is valid there.
    await rename(vmWorktree, join(directory, "vm-storage"));
    await writeFile(join(repositoryRoot, "base.txt"), "local work\n");
    for (const failure of ["fetch", "story-status"]) {
      const runtime = new BlameAgentRuntime(undefined, {
        git: async (cwd, args) => {
          if (
            (failure === "fetch" && args[0] === "fetch") ||
            (failure === "story-status" &&
              cwd === worktree &&
              args[0] === "status")
          ) {
            throw new Error(`Intentional ${failure} failure`);
          }
          return git(cwd, args);
        },
      });
      await assert.rejects(
        runtime.approveAndMerge({
          apiConnection: { url: "https://api.example" },
          modelId: "test-model",
          providerId: "test-provider",
          repositoryRoot,
          worktree,
          storyBranch: "story/review",
          title: "Preserve VM worktree",
          summary: "Cleanup must stay scoped to the merge checkout.",
        }),
        new RegExp(`Intentional ${failure} failure`),
      );
      const registered = await git(repositoryRoot, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      assert.ok(
        registered.includes(vmWorktree),
        "VM worktree registration must survive host cleanup",
      );
      assert.doesNotMatch(registered, /\/\.merge\/main/);
      assert.equal(
        await readFile(join(repositoryRoot, "base.txt"), "utf8"),
        "local work\n",
      );
    }
  } finally {
    new BlameAgentRuntime(undefined, { git });
    await rm(directory, { recursive: true, force: true });
  }
});

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

for (const pending of [false, true]) {
  test(`resolves ${pending ? "an interrupted" : "a new"} story merge with enabled workspace tools`, async () => {
    const fixture = await conflictingStoryFixture();
    let resolutions = 0;
    const runtime = mergeTestRuntime(async (request) => {
      resolutions += 1;
      assert.equal(request.source, "blame-merge-conflict-resolution");
      assert.equal(request.config.cwd, fixture.input.worktree);
      for (const tool of [
        "read_files",
        "search_codebase",
        "editor",
        "apply_patch",
        "run_commands",
      ]) {
        assert.deepEqual(request.toolPolicies?.[tool], {
          enabled: true,
          autoApprove: true,
        });
      }
      assert.equal(request.config.enableSpawnAgent, false);
      assert.equal(request.toolPolicies?.ask_question?.enabled, false);
      assert.match(await readFile(fixture.file, "utf8"), /<<<<<<< HEAD/);
      await writeFile(fixture.file, "story and target\n");
      await git(fixture.input.worktree, ["add", "shared.txt"]);
    });
    try {
      if (pending) {
        await assert.rejects(git(fixture.input.worktree, ["merge", "main"]));
      }
      const result = await runtime.approveAndMerge(fixture.input);
      assert.equal(resolutions, 1);
      assert.equal(result.baseCommit, fixture.targetCommit);
      assert.equal(
        await readFile(
          join(fixture.input.repositoryRoot, "shared.txt"),
          "utf8",
        ),
        "story and target\n",
      );
      assert.equal(
        await git(fixture.input.worktree, ["status", "--porcelain"]),
        "",
      );
      assert.equal(
        await git(fixture.input.repositoryRoot, ["status", "--porcelain"]),
        "",
      );
      const parents = await git(fixture.input.worktree, [
        "show",
        "-s",
        "--format=%P",
        "HEAD",
      ]);
      assert.equal(parents, `${fixture.storyCommit} ${fixture.targetCommit}`);
    } finally {
      await runtime.shutdown();
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });
}

test("a failed resolver restores a usable story and can be retried", async () => {
  const fixture = await conflictingStoryFixture();
  let offline = true;
  const runtime = mergeTestRuntime(async () => {
    if (offline) {
      // Include a partial edit to exercise rollback of the interrupted resolver.
      await writeFile(fixture.file, "partial resolution\n");
      throw new Error("Resolver unavailable");
    }
    await writeFile(fixture.file, "story and target\n");
    await git(fixture.input.worktree, ["add", "shared.txt"]);
  });
  try {
    await assert.rejects(
      runtime.approveAndMerge(fixture.input),
      /Resolver unavailable/,
    );
    assert.equal(await readFile(fixture.file, "utf8"), "story\n");
    assert.equal(
      await git(fixture.input.worktree, ["rev-parse", "HEAD"]),
      fixture.storyCommit,
    );
    assert.equal(
      await git(fixture.input.worktree, ["status", "--porcelain"]),
      "",
    );
    await assert.rejects(
      git(fixture.input.worktree, ["rev-parse", "--verify", "MERGE_HEAD"]),
    );
    assert.equal(
      await git(fixture.input.repositoryRoot, ["rev-parse", "HEAD"]),
      fixture.targetCommit,
    );
    offline = false;
    await runtime.approveAndMerge(fixture.input);
    assert.equal(
      await readFile(join(fixture.input.repositoryRoot, "shared.txt"), "utf8"),
      "story and target\n",
    );
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("resolves a VM story's conflicts through the runtime hub", async () => {
  const fixture = await conflictingStoryFixture();
  const calls: string[] = [];
  // Like the Blame Runtime hub: start() returns at once without a result, and
  // only a sent turn runs the agent and answers with its result.
  const runtime = mergeTestRuntime(undefined, {
    async start(input: ClineCoreStartInput) {
      calls.push(`start:${input.interactive}:${input.prompt ?? ""}`);
      return { sessionId: "hub-merge", result: undefined };
    },
    async send(input: { sessionId: string; prompt: string }) {
      calls.push(`send:${input.sessionId}`);
      assert.match(input.prompt, /Conflicted files:\nshared\.txt/);
      await writeFile(fixture.file, "story and target\n");
      await git(fixture.input.worktree, ["add", "shared.txt"]);
      return { status: "done" };
    },
    async stop(sessionId: string) {
      calls.push(`stop:${sessionId}`);
    },
  });
  try {
    await runtime.approveAndMerge({
      ...fixture.input,
      backend: { mode: "remote", endpoint: "ws://blame-runtime" },
    });
    assert.deepEqual(calls, [
      "start:true:",
      "send:hub-merge",
      "stop:hub-merge",
    ]);
    assert.equal(
      await readFile(join(fixture.input.repositoryRoot, "shared.txt"), "utf8"),
      "story and target\n",
    );
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("reports a resolver that returned no result instead of the conflicts", async () => {
  const fixture = await conflictingStoryFixture();
  const runtime = mergeTestRuntime(undefined, {
    async start() {
      return { sessionId: "silent-merge", result: undefined };
    },
  });
  try {
    await assert.rejects(
      runtime.approveAndMerge(fixture.input),
      /merge conflict agent returned no result/,
    );
    assert.equal(await readFile(fixture.file, "utf8"), "story\n");
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("leaves a merge in progress in the project checkout alone, with its second parent", async () => {
  const fixture = await conflictingStoryFixture();
  const root = fixture.input.repositoryRoot;
  const runtime = mergeTestRuntime();
  try {
    // Someone merges by hand in the project checkout, conflicts resolved
    // but not committed yet.
    await git(root, ["checkout", "-q", "-b", "side", "HEAD~1"]);
    await writeFile(join(root, "shared.txt"), "side\n");
    await git(root, ["commit", "-qam", "side"]);
    await git(root, ["checkout", "-q", "main"]);
    await assert.rejects(git(root, ["merge", "side"]));
    await writeFile(join(root, "shared.txt"), "target and side\n");
    await git(root, ["add", "shared.txt"]);

    await assert.rejects(
      runtime.approveAndMerge(fixture.input),
      /^Error: A Git merge is in progress in .+: commit it or run git merge --abort, then approve again\.$/u,
    );
    assert.ok(await git(root, ["rev-parse", "--verify", "MERGE_HEAD"]));
    assert.equal(await git(root, ["rev-parse", "HEAD"]), fixture.targetCommit);
    assert.equal(await git(root, ["stash", "list"]), "");
    assert.equal(
      await git(fixture.input.worktree, ["rev-parse", "HEAD"]),
      fixture.storyCommit,
    );
    await git(root, ["commit", "-q", "--no-edit"]);
    assert.equal(
      (await git(root, ["show", "-s", "--format=%P", "HEAD"])).split(" ")
        .length,
      2,
    );
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("leaves a rebase stopped in the project checkout alone", async () => {
  const fixture = await conflictingStoryFixture();
  const root = fixture.input.repositoryRoot;
  const runtime = mergeTestRuntime();
  try {
    await git(root, ["checkout", "-q", "-b", "side", "HEAD~1"]);
    await writeFile(join(root, "shared.txt"), "side\n");
    await git(root, ["commit", "-qam", "side"]);
    await assert.rejects(git(root, ["rebase", "main"]));
    await assert.rejects(
      runtime.approveAndMerge(fixture.input),
      /A Git rebase is in progress in .+: run git rebase --continue or --abort, then approve again\./u,
    );
    await git(root, ["rebase", "--abort"]);
    assert.equal(await git(root, ["stash", "list"]), "");
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("merges two stories approved at once into the same repository one after the other", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blame-concurrent-merge-"));
  const repositoryRoot = join(directory, "project");
  await mkdir(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.email", "blame@example.com"]);
  await git(repositoryRoot, ["config", "user.name", "Blame Test"]);
  await writeFile(join(repositoryRoot, ".gitignore"), ".blame/\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", "base"]);
  const stories = [];
  for (const name of ["first", "second"]) {
    const worktree = join(directory, name);
    const storyBranch = `story/${name}`;
    await git(repositoryRoot, ["worktree", "add", "-b", storyBranch, worktree]);
    await writeFile(join(worktree, `${name}.txt`), `${name}\n`);
    await git(worktree, ["add", "."]);
    await git(worktree, ["commit", "-m", name]);
    stories.push({
      apiConnection: { url: "https://api.example" },
      providerId: "test-provider",
      modelId: "test-model",
      repositoryRoot,
      worktree,
      storyBranch,
      title: `Add the ${name} file`,
      summary: "Exercise concurrent approvals.",
    });
  }
  const runtime = mergeTestRuntime();
  try {
    await Promise.all(stories.map((story) => runtime.approveAndMerge(story)));
    assert.equal(
      await readFile(join(repositoryRoot, "first.txt"), "utf8"),
      "first\n",
    );
    assert.equal(
      await readFile(join(repositoryRoot, "second.txt"), "utf8"),
      "second\n",
    );
    assert.equal(await git(repositoryRoot, ["status", "--porcelain"]), "");
  } finally {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("advances a target branch checked out nowhere and pushes it to its own upstream", async () => {
  const fixture = await targetBranchFixture("detached");
  const { repositoryRoot } = fixture;
  const remote = join(fixture.directory, "remote.git");
  await git(fixture.directory, ["init", "--bare", remote]);
  await git(repositoryRoot, ["remote", "add", "origin", remote]);
  // Only the target has an upstream; the project folder's branch has none.
  await git(repositoryRoot, ["push", "--set-upstream", "origin", "develop"]);
  const runtime = mergeTestRuntime();
  try {
    const result = await runtime.approveAndMerge({
      ...fixture.input,
      push: true,
    });

    assert.equal(result.targetBranch, "develop");
    assert.equal(result.mergeCommit, fixture.storyCommit);
    assert.deepEqual(result.push, {
      status: "pushed",
      upstream: "origin/develop",
    });
    assert.equal(
      await git(repositoryRoot, ["rev-parse", "develop"]),
      fixture.storyCommit,
    );
    assert.equal(await git(remote, ["rev-parse", "develop"]), fixture.storyCommit);
    assert.equal(await git(repositoryRoot, ["branch", "--show-current"]), "main");
    assert.equal(
      await git(repositoryRoot, ["rev-parse", "HEAD"]),
      fixture.mainCommit,
    );
    assert.doesNotMatch(
      await git(repositoryRoot, ["worktree", "list", "--porcelain"]),
      /\/\.merge\//,
    );
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("advances a target branch checked out in another clean worktree", async () => {
  const fixture = await targetBranchFixture("other-worktree");
  const { repositoryRoot } = fixture;
  const other = join(fixture.directory, "other");
  await git(repositoryRoot, ["worktree", "add", other, "develop"]);
  await git(repositoryRoot, [
    "remote",
    "add",
    "origin",
    join(fixture.directory, "unpublished.git"),
  ]);
  const runtime = mergeTestRuntime();
  try {
    const result = await runtime.approveAndMerge({
      ...fixture.input,
      push: true,
    });

    assert.equal(await git(other, ["rev-parse", "HEAD"]), fixture.storyCommit);
    assert.equal(await readFile(join(other, "story.txt"), "utf8"), "story\n");
    assert.equal(await git(other, ["status", "--porcelain"]), "");
    assert.equal(
      await git(repositoryRoot, ["rev-parse", "HEAD"]),
      fixture.mainCommit,
    );
    // Without an upstream the merge stays local, and says where to publish it.
    assert.deepEqual(result.push, { status: "no-upstream", remote: "origin" });
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

for (const blocker of ["uncommitted changes", "a running agent"] as const) {
  test(`leaves a target branch checked out in a worktree with ${blocker} alone`, async () => {
    const fixture = await targetBranchFixture("busy-worktree");
    const { repositoryRoot } = fixture;
    const other = join(fixture.directory, "other");
    await git(repositoryRoot, ["worktree", "add", other, "develop"]);
    const developCommit = await git(repositoryRoot, ["rev-parse", "develop"]);
    if (blocker === "uncommitted changes")
      await writeFile(join(other, "work-in-progress.txt"), "draft\n");
    const runtime = mergeTestRuntime();
    try {
      await assert.rejects(
        runtime.approveAndMerge({
          ...fixture.input,
          activeWorktrees: blocker === "a running agent" ? [other] : [],
        }),
        blocker === "a running agent"
          ? /develop is checked out in .+, where an agent is running/
          : /develop is checked out in .+, which has uncommitted changes/,
      );
      assert.equal(
        await git(repositoryRoot, ["rev-parse", "develop"]),
        developCommit,
      );
      assert.equal(
        await git(fixture.worktree, ["rev-parse", "HEAD"]),
        fixture.storyCommit,
      );
    } finally {
      await runtime.shutdown();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
}

for (const [targetBranch, error] of [
  ["missing", /Target branch missing does not exist/],
  ["story/target", /Story branch and target branch must be different/],
] as const) {
  test(`refuses to merge into target branch ${targetBranch}`, async () => {
    const fixture = await targetBranchFixture("invalid-target");
    const runtime = mergeTestRuntime();
    try {
      await assert.rejects(
        runtime.approveAndMerge({ ...fixture.input, targetBranch }),
        error,
      );
      assert.equal(
        await git(fixture.repositoryRoot, ["rev-parse", "HEAD"]),
        fixture.mainCommit,
      );
    } finally {
      await runtime.shutdown();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
}

// A story started from develop while the project folder stays on main.
async function targetBranchFixture(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `blame-target-${name}-`));
  const repositoryRoot = join(directory, "project");
  const worktree = join(directory, "story");
  await mkdir(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.email", "blame@example.com"]);
  await git(repositoryRoot, ["config", "user.name", "Blame Test"]);
  await writeFile(join(repositoryRoot, ".gitignore"), ".blame/\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", "base"]);
  await git(repositoryRoot, ["branch", "develop"]);
  await git(repositoryRoot, ["commit", "--allow-empty", "-m", "main only"]);
  const mainCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  await git(repositoryRoot, [
    "worktree",
    "add",
    "-b",
    "story/target",
    worktree,
    "develop",
  ]);
  await writeFile(join(worktree, "story.txt"), "story\n");
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", "story"]);
  const storyCommit = await git(worktree, ["rev-parse", "HEAD"]);
  return {
    directory,
    mainCommit,
    repositoryRoot,
    storyCommit,
    worktree,
    input: {
      apiConnection: { url: "https://api.example" },
      providerId: "test-provider",
      modelId: "test-model",
      repositoryRoot,
      worktree,
      storyBranch: "story/target",
      targetBranch: "develop",
      title: "Ship on develop",
      summary: "Merge into the branch the story started from.",
    },
  };
}
function mergeTestRuntime(
  resolve?: (input: ClineCoreStartInput) => Promise<void>,
  core?: Record<string, unknown>,
) {
  const runtime = new BlameAgentRuntime(undefined, {
    createCore: async () =>
      ({
        async start(input: ClineCoreStartInput) {
          await resolve?.(input);
          return { sessionId: "merge-test", result: { status: "done" } };
        },
        async dispose() {},
        ...core,
      }) as never,
  });
  const internals = runtime as unknown as {
    runtimeCredential(): Promise<{ apiKey: string; baseUrl: null }>;
  };
  internals.runtimeCredential = async () => ({
    apiKey: "test-key",
    baseUrl: null,
  });
  return runtime;
}

async function conflictingStoryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "blame-conflict-resolver-"));
  const repositoryRoot = join(directory, "project");
  const worktree = join(directory, "story");
  await mkdir(repositoryRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.email", "blame@example.com"]);
  await git(repositoryRoot, ["config", "user.name", "Blame Test"]);
  await writeFile(join(repositoryRoot, ".gitignore"), ".blame/\n");
  await writeFile(join(repositoryRoot, "shared.txt"), "base\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", "base"]);
  await git(repositoryRoot, [
    "worktree",
    "add",
    "-b",
    "story/review",
    worktree,
  ]);
  const file = join(worktree, "shared.txt");
  await writeFile(file, "story\n");
  await git(worktree, ["commit", "-am", "story"]);
  const storyCommit = await git(worktree, ["rev-parse", "HEAD"]);
  await writeFile(join(repositoryRoot, "shared.txt"), "target\n");
  await git(repositoryRoot, ["commit", "-am", "target"]);
  const targetCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  return {
    directory,
    file,
    storyCommit,
    targetCommit,
    input: {
      apiConnection: { url: "https://api.example" },
      providerId: "test-provider",
      modelId: "test-model",
      repositoryRoot,
      worktree,
      storyBranch: "story/review",
      title: "Combine two stories",
      summary: "Preserve both compatible changes.",
    },
  };
}
