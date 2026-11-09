import assert from "node:assert/strict";
import test from "node:test";
import { githubIssueUrl, parseIssueReport } from "./github-issue.ts";

const environment = {
  arch: "arm64",
  home: "/Users/ada",
  os: "macOS 15.5",
  version: "1.4.0",
};

function issue(url: string) {
  const parsed = new URL(url);
  return {
    body: parsed.searchParams.get("body") ?? "",
    origin: `${parsed.origin}${parsed.pathname}`,
    title: parsed.searchParams.get("title") ?? "",
  };
}

test("opens a new issue with the version, system and error", () => {
  const { body, origin, title } = issue(
    githubIssueUrl(
      { error: "Lima failed to start the VM", title: "Runtime repair failed" },
      environment,
    ),
  );

  assert.equal(origin, "https://github.com/rchrp/Blame/issues/new");
  assert.equal(title, "Runtime repair failed");
  assert.match(body, /Lima failed to start the VM/);
  assert.match(body, /- Blame 1\.4\.0\n- macOS 15\.5\n- arm64/);
});

test("shows the home folder as ~ and masks secrets", () => {
  const { body } = issue(
    githubIssueUrl(
      {
        error:
          "ENOENT: /Users/ada/projects/app/.env\nGH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n/Users/adam stays",
        title: "Runtime setup failed in /Users/ada",
      },
      environment,
    ),
  );

  assert.match(body, /ENOENT: ~\/projects\/app\/\.env/);
  assert.match(body, /\/Users\/adam stays/);
  assert.doesNotMatch(body, /ghp_/);
});

test("handles Windows home folders in either slash style", () => {
  const { body } = issue(
    githubIssueUrl(
      { error: "C:\\Users\\Ada\\repo and c:/users/ada/repo", title: "Failed" },
      { ...environment, home: "C:\\Users\\Ada" },
    ),
  );

  assert.match(body, /~\\repo and ~\/repo/);
});

test("truncates long errors so the URL stays short", () => {
  const url = githubIssueUrl(
    { error: "é".repeat(20_000), title: "Crash" },
    environment,
  );

  assert.ok(url.length <= 6_000);
  assert.match(issue(url).body, /\[truncated\]/);
});

test("keeps backticks in the error inside the code block", () => {
  const { body } = issue(
    githubIssueUrl({ error: "bad ``` fence", title: "Failed" }, environment),
  );

  assert.match(body, /````\nbad ``` fence\n````/);
});

test("rejects malformed reports", () => {
  assert.throws(() => parseIssueReport({ title: "Failed" }));
  assert.deepEqual(parseIssueReport({ error: "x", extra: 1, title: "t" }), {
    error: "x",
    title: "t",
  });
});
