import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { BlameAgentRuntime } from "./cline-runtime.js";
import {
  githubRepository,
  pullRequestAvailability,
  pullRequestBody,
} from "./pull-request.js";

const execFileAsync = promisify(execFile);

test("reads the GitHub repository of an origin URL", () => {
  for (const url of [
    "https://github.com/acme/shop.git",
    "https://github.com/acme/shop",
    "git@github.com:acme/shop.git",
    "ssh://git@github.com/acme/shop.git",
    "https://user@github.com/acme/shop/",
  ])
    assert.equal(githubRepository(url), "acme/shop", url);
  for (const url of [
    "https://gitlab.com/acme/shop.git",
    "git@bitbucket.org:acme/shop.git",
    "/srv/git/shop.git",
    "https://github.com/acme",
    "",
  ])
    assert.equal(githubRepository(url), undefined, url);
});

test("builds the pull request body from the story, its criteria and the agent summary", () => {
  const body = pullRequestBody({
    summary: [
      "Add a checkout button.",
      "",
      "## Acceptance criteria",
      "- [ ] The button is visible",
      "- [ ] It opens the cart",
      "",
      "## Notes",
      "Keep the style.",
    ].join("\n"),
    agentSummary: "Added `CheckoutButton`.",
  });
  assert.equal(
    body,
    [
      "## Story",
      "",
      "Add a checkout button.",
      "",
      "## Notes",
      "Keep the style.",
      "",
      "## Acceptance criteria",
      "",
      "- [ ] The button is visible",
      "- [ ] It opens the cart",
      "",
      "## Agent summary",
      "",
      "Added `CheckoutButton`.",
      "",
      "---",
      "_Opened from Blame._",
    ].join("\n"),
  );
});

test("keeps a story without criteria or agent summary whole", () => {
  assert.equal(
    pullRequestBody({ summary: "Fix the typo.\n" }),
    "## Story\n\nFix the typo.\n\n---\n_Opened from Blame._",
  );
});

test("caps the pull request body at GitHub's limit", () => {
  const body = pullRequestBody({
    summary: "Story",
    agentSummary: "x".repeat(70_000),
  });
  assert.equal(body.length, 65_536);
  assert.match(body, /_\[truncated\]_$/);
});

test("offers pull requests only for a GitHub origin and a signed-in gh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blame-pr-availability-"));
  try {
    await git(directory, ["init", "--initial-branch=main"]);
    const signedIn = async () => "";
    assert.deepEqual(await pullRequestAvailability(directory, signedIn), {
      status: "not-github",
    });
    await git(directory, ["remote", "add", "origin", "git@gitlab.com:a/b.git"]);
    assert.deepEqual(await pullRequestAvailability(directory, signedIn), {
      status: "not-github",
    });
    await git(directory, [
      "remote",
      "set-url",
      "origin",
      "git@github.com:acme/shop.git",
    ]);
    assert.deepEqual(await pullRequestAvailability(directory, signedIn), {
      status: "available",
      repository: "acme/shop",
    });
    const missing = await pullRequestAvailability(directory, async () => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    });
    assert.equal(missing.status, "gh-missing");
    assert.match("message" in missing ? missing.message : "", /gh auth login/);
    const signedOut = await pullRequestAvailability(directory, async () => {
      throw Object.assign(new Error("not logged in"), { code: 1 });
    });
    assert.equal(signedOut.status, "gh-signed-out");
    assert.match(
      "message" in signedOut ? signedOut.message : "",
      /gh auth login/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commits, pushes the story branch and opens its pull request once", async () => {
  const fixture = await pullRequestFixture();
  const gh = fakeGh();
  const runtime = pullRequestTestRuntime(gh.run);
  try {
    await writeFile(join(fixture.worktree, "remaining.txt"), "left over\n");
    const first = await runtime.openPullRequest(fixture.input);

    assert.deepEqual(first, {
      created: true,
      targetBranch: "develop",
      url: "https://github.com/acme/shop/pull/7",
    });
    const storyHead = await git(fixture.worktree, ["rev-parse", "HEAD"]);
    assert.equal(
      await git(fixture.remote, ["rev-parse", "story/pr"]),
      storyHead,
    );
    await git(fixture.remote, ["cat-file", "-e", "story/pr:remaining.txt"]);
    // The runtime env file the agent committed never reaches GitHub; it stays
    // in the worktree, untracked.
    await assert.rejects(
      git(fixture.remote, ["cat-file", "-e", "story/pr:.env"]),
    );
    assert.equal(
      await git(fixture.worktree, ["status", "--porcelain"]),
      "?? .env",
    );
    const create = gh.calls.find((args) => args[1] === "create");
    assert.ok(create);
    assert.deepEqual(option(create, "--repo"), "acme/shop");
    assert.deepEqual(option(create, "--base"), "develop");
    assert.deepEqual(option(create, "--head"), "story/pr");
    assert.deepEqual(option(create, "--title"), "Ship the checkout");
    const body = option(create, "--body") ?? "";
    assert.match(body, /## Acceptance criteria\n\n- \[ \] Pay by card/);
    assert.match(body, /## Agent summary\n\nCheckout shipped\./);

    const second = await runtime.openPullRequest(fixture.input);
    assert.deepEqual(second, { ...first, created: false });
    assert.equal(
      gh.calls.filter((args) => args[1] === "create").length,
      1,
    );
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("explains how to sign gh in instead of pushing", async () => {
  const fixture = await pullRequestFixture();
  const runtime = pullRequestTestRuntime(async (_cwd, args) => {
    if (args[0] === "auth") throw Object.assign(new Error("no"), { code: 1 });
    throw new Error(`unexpected gh ${args.join(" ")}`);
  });
  try {
    await assert.rejects(
      runtime.openPullRequest(fixture.input),
      /gh auth login/,
    );
    await assert.rejects(git(fixture.remote, ["rev-parse", "story/pr"]));
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("merges without pushing by default and pushes only when asked", async () => {
  const fixture = await pullRequestFixture();
  const { repositoryRoot } = fixture;
  // The merge fetches its target's upstream: keep it off the network.
  await git(repositoryRoot, ["remote", "set-url", "origin", fixture.remote]);
  await git(repositoryRoot, ["push", "--set-upstream", "origin", "develop"]);
  const pushedDevelop = await git(fixture.remote, ["rev-parse", "develop"]);
  const runtime = pullRequestTestRuntime(fakeGh().run);
  try {
    const result = await runtime.approveAndMerge(fixture.input);

    assert.deepEqual(result.push, { status: "skipped" });
    assert.equal(
      await git(repositoryRoot, ["rev-parse", "develop"]),
      result.mergeCommit,
    );
    assert.equal(await git(fixture.remote, ["rev-parse", "develop"]), pushedDevelop);
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("pushes the merged target branch when asked", async () => {
  const fixture = await pullRequestFixture();
  const { repositoryRoot } = fixture;
  await git(repositoryRoot, ["remote", "set-url", "origin", fixture.remote]);
  await git(repositoryRoot, ["push", "--set-upstream", "origin", "develop"]);
  const runtime = pullRequestTestRuntime(fakeGh().run);
  try {
    const result = await runtime.approveAndMerge({
      ...fixture.input,
      push: true,
    });

    assert.deepEqual(result.push, {
      status: "pushed",
      upstream: "origin/develop",
    });
    assert.equal(
      await git(fixture.remote, ["rev-parse", "develop"]),
      result.mergeCommit,
    );
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

// A story started from develop, in a project whose origin is on GitHub but
// pushes to a local bare repository.
async function pullRequestFixture() {
  const directory = await mkdtemp(join(tmpdir(), "blame-pull-request-"));
  const repositoryRoot = join(directory, "project");
  const worktree = join(directory, "story");
  const remote = join(directory, "remote.git");
  await mkdir(repositoryRoot);
  await git(directory, ["init", "--bare", remote]);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.email", "blame@example.com"]);
  await git(repositoryRoot, ["config", "user.name", "Blame Test"]);
  await git(repositoryRoot, [
    "remote",
    "add",
    "origin",
    "https://github.com/acme/shop.git",
  ]);
  await git(repositoryRoot, ["remote", "set-url", "--push", "origin", remote]);
  await writeFile(join(repositoryRoot, ".gitignore"), ".blame/\n");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", "base"]);
  await git(repositoryRoot, ["branch", "develop"]);
  await git(repositoryRoot, [
    "worktree",
    "add",
    "-b",
    "story/pr",
    worktree,
    "develop",
  ]);
  await writeFile(join(worktree, "checkout.txt"), "checkout\n");
  await writeFile(join(worktree, ".env"), "SECRET=1\n");
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", "checkout"]);
  return {
    directory,
    remote,
    repositoryRoot,
    worktree,
    input: {
      apiConnection: { url: "https://api.example" },
      providerId: "test-provider",
      modelId: "test-model",
      repositoryRoot,
      worktree,
      storyBranch: "story/pr",
      targetBranch: "develop",
      title: "Ship the checkout",
      summary: "Let people pay.\n\n## Acceptance criteria\n- [ ] Pay by card",
      agentSummary: "Checkout shipped.",
    },
  };
}

// gh as GitHub would answer it: the pull request exists once created.
function fakeGh() {
  const calls: string[][] = [];
  let url: string | undefined;
  return {
    calls,
    async run(_cwd: string, args: string[]) {
      calls.push(args);
      if (args[0] === "auth") return "";
      if (args[0] === "pr" && args[1] === "list")
        return JSON.stringify(url ? [{ url }] : []);
      if (args[0] === "pr" && args[1] === "create") {
        url = "https://github.com/acme/shop/pull/7";
        return `Creating pull request\n${url}\n`;
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  };
}

function pullRequestTestRuntime(
  gh: (cwd: string, args: string[]) => Promise<string>,
) {
  const runtime = new BlameAgentRuntime(undefined, {
    createCore: async () =>
      ({
        async start() {
          return { sessionId: "pr-test", result: { status: "done" } };
        },
        async dispose() {},
      }) as never,
    gh,
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

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
