import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { GhRunner } from "../../pull-request.js";
import {
  pullRequestTextPrompt,
  pullRequestTextResult,
} from "../purposes/pull-request-text.js";
import type {
  ApproveAndMergeTask,
  GenerateCommitMessageTask,
  OpenPullRequestTask,
} from "../task-protocol.js";
import { EngineTaskError, type TaskSpec } from "../tasks/runner.js";
import type { GitAgent } from "./agent.js";
import { generateCommitMessage } from "./commit-message.js";
import { openPullRequest } from "./pull-request.js";
import { approveAndMerge } from "./story-merge.js";

const execFileAsync = promisify(execFile);

test("asks for the pull request text with the story and its agent summary only", () => {
  assert.equal(
    pullRequestTextPrompt({
      title: "Livrer le paiement",
      summary: "Permettre de payer.\n",
      agentSummary: "  Paiement livré.  ",
    }),
    [
      "<pr_title>\nLivrer le paiement\n</pr_title>",
      "<pr_description>\nPermettre de payer.\n</pr_description>",
      "<pr_agent_summary>\nPaiement livré.\n</pr_agent_summary>",
    ].join("\n\n"),
  );
  assert.doesNotMatch(
    pullRequestTextPrompt({ title: "Fix", summary: "Typo" }),
    /pr_agent_summary/,
  );
});

test("reads the English pull request text the agent gives", () => {
  const given = {
    title: " Ship  the\ncheckout ",
    description: "Let people pay.\n",
    agentSummary: "Checkout shipped.",
  };
  assert.deepEqual(pullRequestTextResult(given, true), {
    title: "Ship the checkout",
    summary: "Let people pay.",
    agentSummary: "Checkout shipped.",
  });
  assert.deepEqual(pullRequestTextResult(given, false), {
    title: "Ship the checkout",
    summary: "Let people pay.",
  });
  assert.throws(
    () => pullRequestTextResult({ title: " ", description: "Pay." }, false),
    /left out its title/,
  );
  assert.throws(
    () => pullRequestTextResult({ title: "Ship", description: "Pay." }, true),
    /left out the agent summary/,
  );
});

test("commits, pushes the story branch and opens its pull request once", async () => {
  const fixture = await pullRequestFixture();
  const gh = fakeGh();
  const prompts: string[] = [];
  const runtime = pullRequestTestRuntime(gh.run, { prompts });
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
    // The story is written in French; the pull request is not.
    assert.doesNotMatch(body, /Critères|Paiement|Permettre/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /Livrer le paiement/);

    const second = await runtime.openPullRequest(fixture.input);
    assert.deepEqual(second, { ...first, created: false });
    assert.equal(gh.calls.filter((args) => args[1] === "create").length, 1);
    // Pushing to an existing pull request needs no new text.
    assert.equal(prompts.length, 1);
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("opens the pull request on a retry when the agent did not write it in English", async () => {
  const fixture = await pullRequestFixture();
  const gh = fakeGh();
  const runtime = pullRequestTestRuntime(gh.run, {
    answers: [undefined, englishPullRequest],
  });
  try {
    await assert.rejects(
      runtime.openPullRequest(fixture.input),
      /did not write the pull request in English/,
    );
    assert.equal(gh.calls.filter((args) => args[1] === "create").length, 0);
    // The work is already on GitHub; the retry only creates the pull request.
    await git(fixture.remote, ["rev-parse", "story/pr"]);

    const retry = await runtime.openPullRequest(fixture.input);
    assert.equal(retry.created, true);
    assert.equal(gh.calls.filter((args) => args[1] === "create").length, 1);
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
    assert.equal(
      await git(fixture.remote, ["rev-parse", "develop"]),
      pushedDevelop,
    );
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

test("closes the origin issues the story handles from its merged commit", async () => {
  const fixture = await pullRequestFixture();
  const runtime = pullRequestTestRuntime(fakeGh().run);
  try {
    await writeFile(join(fixture.worktree, "card.ts"), "export {};\n");
    await runtime.approveAndMerge({
      ...fixture.input,
      push: false,
      title: "Pay by card",
      summary: [
        "Traite la GitHub issue [12](https://github.com/acme/shop/issues/12).",
        "Fixes https://github.com/Acme/Shop/issues/4, not https://github.com/acme/api/issues/7.",
        "Hors périmètre : [#45](https://github.com/acme/shop/issues/45).",
      ].join("\n"),
    });

    // The test agent writes no message: Blame falls back to its own.
    const messages = (
      await git(fixture.repositoryRoot, ["log", "--format=%B%x00", "develop"])
    )
      .split("\0")
      .map((message) => message.trim());
    assert.ok(
      messages.includes("fix(card): pay by card\n\nCloses #4\nCloses #12"),
      messages.join("\n---\n"),
    );
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("closes the issues the story handles from its pull request and its commit", async () => {
  const fixture = await pullRequestFixture();
  const gh = fakeGh();
  const runtime = pullRequestTestRuntime(gh.run);
  try {
    await writeFile(join(fixture.worktree, "card.ts"), "export {};\n");
    await runtime.openPullRequest({
      ...fixture.input,
      summary: [
        fixture.input.summary,
        "Traite la GitHub issue [63](https://github.com/acme/shop/issues/63).",
        "Hors périmètre : [#64](https://github.com/acme/shop/issues/64), https://github.com/acme/api/issues/2.",
      ].join("\n\n"),
    });

    // The English text leaves the links out: the story's own text has them.
    const create = gh.calls.find((args) => args[1] === "create") ?? [];
    const body = option(create, "--body") ?? "";
    assert.match(
      body,
      /- \[ \] Pay by card\n\n## Agent summary\n\nCheckout shipped\.\n\nCloses #63\n\n---\n/u,
    );
    assert.doesNotMatch(body, /Closes #(?:2|64)\b/u);
    const messages = (
      await git(fixture.remote, ["log", "--format=%B%x00", "story/pr"])
    )
      .split("\0")
      .map((message) => message.trim());
    assert.ok(
      messages.includes("fix(card): livrer le paiement\n\nCloses #63"),
      messages.join("\n---\n"),
    );
  } finally {
    await runtime.shutdown();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a Direct story's commit message closes the issues it handles, the Git page's doesn't", async () => {
  const fixture = await pullRequestFixture();
  const runtime = pullRequestTestRuntime(fakeGh().run);
  try {
    // Direct commits in the project folder itself.
    const root = fixture.repositoryRoot;
    await writeFile(join(root, "card.ts"), "export {};\n");
    const request = {
      model: fixture.input.model,
      repositoryRoot: root,
      worktree: root,
      selectedPaths: ["card.ts"],
      title: "Pay by card",
      summary:
        "Traite la GitHub issue [12](https://github.com/acme/shop/issues/12).",
    };

    assert.deepEqual(
      await runtime.generateCommitMessage({
        ...request,
        closeLinkedIssues: true,
      }),
      { message: "fix(card): pay by card\n\nCloses #12" },
    );
    assert.deepEqual(await runtime.generateCommitMessage(request), {
      message: "fix(card): pay by card",
    });
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
      model: { providerId: "anthropic", modelId: "test-model" },
      repositoryRoot,
      worktree,
      storyBranch: "story/pr",
      targetBranch: "develop",
      title: "Livrer le paiement",
      summary:
        "Permettre de payer.\n\n## Critères d'acceptation\n- [ ] Payer par carte",
      agentSummary: "Paiement livré.",
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

// What the agent gives when asked to write the pull request in English.
const englishPullRequest = {
  title: "Ship the checkout",
  description: "Let people pay.\n\n## Acceptance criteria\n- [ ] Pay by card",
  agentSummary: "Checkout shipped.",
};

// The flows with a stand-in for their engine tasks: the commit message is
// left to its fallback, and the pull request text is given, or not.
function pullRequestTestRuntime(
  gh: GhRunner,
  agent: { answers?: Array<object | undefined>; prompts?: string[] } = {},
) {
  const answers = [...(agent.answers ?? [englishPullRequest])];
  const run: GitAgent = async <R>(_call: unknown, spec: TaskSpec<R>) => {
    if (spec.config.purpose !== "pull-request-text")
      throw new Error("No commit message agent in this test.");
    agent.prompts?.push(spec.instruction);
    const answer = answers.shift();
    if (!answer)
      throw new EngineTaskError(
        "pr-test",
        {
          status: "failed",
          failure: {
            kind: "contract_unmet",
            unmet: [{ kind: "result", tool: "submit_pull_request" }],
          },
        } as never,
        "The pull request agent",
      );
    return { session: "pr-test", result: spec.result(answer) };
  };
  return {
    approveAndMerge: (input: ApproveAndMergeTask) =>
      approveAndMerge(input, run),
    openPullRequest: (input: OpenPullRequestTask) =>
      openPullRequest(input, { agent: run, gh }),
    generateCommitMessage: (input: GenerateCommitMessageTask) =>
      generateCommitMessage(input, run),
    async shutdown() {},
  };
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
