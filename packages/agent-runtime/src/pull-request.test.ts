import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { BlameAgentRuntime } from "./cline-runtime.js";
import {
  parsePullRequestState,
  pullRequestAvailability,
  pullRequestBody,
  readPullRequestState,
} from "./pull-request.js";
import {
  parsePullRequestText,
  pullRequestTextPrompt,
} from "./pull-request-text.js";
import { githubRepository } from "./runtime-git.js";

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

test("ends the pull request body with a Closes line per issue it closes", () => {
  assert.equal(
    pullRequestBody({ summary: "Fix the typo." }, [4, 12]),
    "## Story\n\nFix the typo.\n\nCloses #4\nCloses #12\n\n---\n_Opened from Blame._",
  );
});

test("caps the pull request body at GitHub's limit, never its Closes lines", () => {
  const story = { summary: "Story", agentSummary: "x".repeat(70_000) };
  const body = pullRequestBody(story, [4, 12]);
  assert.equal(body.length, 65_536);
  assert.match(
    body,
    /x\n\n_\[truncated\]_\n\nCloses #4\nCloses #12\n\n---\n_Opened from Blame\._$/u,
  );
  const withoutIssues = pullRequestBody(story);
  assert.equal(withoutIssues.length, 65_536);
  assert.match(
    withoutIssues,
    /x\n\n_\[truncated\]_\n\n---\n_Opened from Blame\._$/u,
  );
});

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

test("reads the English pull request text the agent returns", () => {
  const answer = [
    "Here you go:",
    "<pr_title>\n Ship  the\ncheckout </pr_title>",
    "<pr_description>",
    "Let people pay.",
    "<details><summary>Notes</summary>Keep the style.</details>",
    "</pr_description>",
    "<pr_agent_summary>Checkout shipped.</pr_agent_summary>",
  ].join("\n");
  const summary =
    "Let people pay.\n<details><summary>Notes</summary>Keep the style.</details>";
  assert.deepEqual(parsePullRequestText(answer, true), {
    title: "Ship the checkout",
    summary,
    agentSummary: "Checkout shipped.",
  });
  assert.deepEqual(parsePullRequestText(answer, false), {
    title: "Ship the checkout",
    summary,
  });
});

test("rejects an answer that lacks a section the pull request needs", () => {
  assert.equal(parsePullRequestText(undefined, false), undefined);
  assert.equal(parsePullRequestText("Ship the checkout", false), undefined);
  assert.equal(
    parsePullRequestText("<pr_description>Pay.</pr_description>", false),
    undefined,
  );
  assert.equal(
    parsePullRequestText(
      "<pr_title> </pr_title><pr_description>Pay.</pr_description>",
      false,
    ),
    undefined,
  );
  assert.equal(
    parsePullRequestText(
      "<pr_title>Ship</pr_title><pr_description>Pay.</pr_description>",
      true,
    ),
    undefined,
  );
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

test("reads the state of a pull request from gh pr view", () => {
  assert.deepEqual(
    parsePullRequestState('{"state":"OPEN","mergedAt":null}'),
    { status: "open" },
  );
  assert.deepEqual(
    parsePullRequestState('{"state":"CLOSED","mergedAt":null}'),
    { status: "closed" },
  );
  assert.deepEqual(
    parsePullRequestState(
      '{"state":"MERGED","mergedAt":"2026-11-09T10:15:00Z"}',
    ),
    { status: "merged", mergedAt: "2026-11-09T10:15:00Z" },
  );
});

test("tells a merged pull request by mergedAt, not by an approval", () => {
  assert.deepEqual(
    parsePullRequestState(
      '{"state":"OPEN","mergedAt":null,"reviewDecision":"APPROVED"}',
    ),
    { status: "open" },
  );
  // mergedAt is the proof of the merge, whatever state says.
  assert.equal(
    parsePullRequestState(
      '{"state":"CLOSED","mergedAt":"2026-11-09T10:15:00Z"}',
    ).status,
    "merged",
  );
});

test("refuses an answer of gh pr view it does not understand", () => {
  for (const output of ["", "null", "[]", "{}", '{"state":"DRAFT"}'])
    assert.throws(() => parsePullRequestState(output), Error, output);
});

test("asks gh for the state of the pull request by its URL", async () => {
  const url = "https://github.com/acme/shop/pull/7";
  const calls: string[][] = [];
  const state = await readPullRequestState(
    "/project",
    url,
    async (_cwd, args) => {
      calls.push(args);
      return '{"state":"MERGED","mergedAt":"2026-11-09T10:15:00Z"}';
    },
  );
  assert.deepEqual(state, {
    status: "merged",
    mergedAt: "2026-11-09T10:15:00Z",
  });
  assert.deepEqual(calls, [["pr", "view", url, "--json", "state,mergedAt"]]);
});

test("knows nothing of a pull request when gh is missing, signed out or offline", async () => {
  const url = "https://github.com/acme/shop/pull/7";
  for (const failure of [
    Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }),
    Object.assign(new Error("not logged in"), { code: 1 }),
  ])
    assert.deepEqual(
      await readPullRequestState("/project", url, async () => {
        throw failure;
      }),
      { status: "unavailable" },
    );
});

test("never hands gh a pull request URL it could read as an option", async () => {
  for (const url of ["--web", "", "http://github.com/acme/shop/pull/7"])
    await assert.rejects(
      readPullRequestState("/project", url, async () => {
        throw new Error("gh must not run");
      }),
      /URL is invalid/,
      url,
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
    assert.equal(
      gh.calls.filter((args) => args[1] === "create").length,
      1,
    );
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
    answers: ["Ship the checkout", englishPullRequestAnswer],
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
    assert.match(body, /- \[ \] Pay by card\n\n## Agent summary\n\nCheckout shipped\.\n\nCloses #63\n\n---\n/u);
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
      apiConnection: fixture.input.apiConnection,
      providerId: fixture.input.providerId,
      modelId: fixture.input.modelId,
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
      apiConnection: { url: "https://api.example" },
      providerId: "test-provider",
      modelId: "test-model",
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

// What the agent answers when asked to write the pull request in English.
const englishPullRequestAnswer = [
  "<pr_title>Ship the checkout</pr_title>",
  "<pr_description>",
  "Let people pay.",
  "",
  "## Acceptance criteria",
  "- [ ] Pay by card",
  "</pr_description>",
  "<pr_agent_summary>Checkout shipped.</pr_agent_summary>",
].join("\n");

function pullRequestTestRuntime(
  gh: (cwd: string, args: string[]) => Promise<string>,
  agent: { answers?: string[]; prompts?: string[] } = {},
) {
  const answers = [...(agent.answers ?? [englishPullRequestAnswer])];
  const runtime = new BlameAgentRuntime(undefined, {
    createCore: async () =>
      ({
        // The commit message is left to its fallback; only the pull request
        // text is answered.
        async start(input: { prompt?: string }) {
          if (!input.prompt?.includes("<pr_title>"))
            return { sessionId: "pr-test", result: { status: "done" } };
          agent.prompts?.push(input.prompt);
          return {
            sessionId: "pr-test",
            result: { status: "done", text: answers.shift() },
          };
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
