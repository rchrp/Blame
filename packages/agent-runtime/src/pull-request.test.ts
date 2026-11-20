import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  parsePullRequestState,
  pullRequestAvailability,
  pullRequestBody,
  readPullRequestState,
} from "./pull-request.js";
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

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
