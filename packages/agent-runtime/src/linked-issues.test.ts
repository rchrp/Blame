import assert from "node:assert/strict";
import test from "node:test";

import {
  linkedIssueNumbers,
  withLinkedIssueTrailers,
} from "./linked-issues.js";

const origin = "https://github.com/acme/shop.git";
const issue = (number: number) =>
  `https://github.com/acme/shop/issues/${number}`;

test("closes the issues the backlog's stories handle, not those they leave out", () => {
  const blame = "git@github.com:rchrp/Blame.git";
  const url = (number: number) =>
    `https://github.com/rchrp/Blame/issues/${number}`;
  const closed = (summary: string) => linkedIssueNumbers({ summary }, blame);

  // US-84
  assert.deepEqual(
    closed(
      [
        `Traite la GitHub issue [59](${url(59)}) : un commit par story.`,
        "",
        `Hors périmètre : commits multiples ciblés ([#45](${url(45)})).`,
      ].join("\n"),
    ),
    [59],
  );
  // US-86
  assert.deepEqual(
    closed(
      [
        `Traite la GitHub issue [61](${url(61)}).`,
        "",
        `…un bug distinct du bridge (issue [#60](${url(60)})) : hors périmètre ici.`,
      ].join("\n"),
    ),
    [61],
  );
  assert.deepEqual(
    closed(
      `Remplace l'US-035, jamais commencée, et traite la GitHub issue [40](${url(40)}).`,
    ),
    [40],
  );
});

test("reads a closing reference in any form", () => {
  const story = {
    title: `Pay by card, fixes ${issue(3)}`,
    summary: [
      `Traite la GitHub issue [12](${issue(12)}).`,
      "Closes the GitHub issue <http://www.github.com/ACME/Shop/issues/31/>",
      `Résout l’issue ${issue(40)}#issuecomment-99`,
      `ferme #41, corrige acme/shop#42 and resolves: [#43](${issue(43)} "Issue 43")`,
    ].join("\n"),
  };
  for (const url of [
    origin,
    "https://github.com/acme/shop",
    "git@github.com:Acme/Shop.git",
    "ssh://git@github.com/acme/shop.git",
  ])
    assert.deepEqual(
      linkedIssueNumbers(story, url),
      [3, 12, 31, 40, 41, 42, 43],
      url,
    );
});

test("closes each issue that has its own closing word", () => {
  assert.deepEqual(
    linkedIssueNumbers(
      {
        summary: `Traite la GitHub issue [59](${issue(59)}) et corrige [#61](${issue(61)}).`,
      },
      origin,
    ),
    [59, 61],
  );
  assert.deepEqual(
    linkedIssueNumbers({ summary: `Fixes ${issue(12)}` }, origin),
    [12],
  );
  // As on GitHub, one closing word closes one issue.
  assert.deepEqual(
    linkedIssueNumbers({ summary: "Fixes #9 and #10" }, origin),
    [9],
  );
});

test("leaves an issue open when no closing word leads to it", () => {
  const summary = [
    `See ${issue(1)}.`,
    `Corrige le crash. Voir ${issue(2)}.`,
    "Fixes the crash; see #3",
    "Traite : #4",
    "Fixes",
    issue(5),
    `Fixes the crash people see when paying ${issue(6)}`,
    "Ne traite pas l'issue #7",
    "This doesn't fix #8",
  ].join("\n");
  assert.deepEqual(linkedIssueNumbers({ summary }, origin), []);
  assert.equal(
    withLinkedIssueTrailers("feat(checkout): pay by card", { summary }, origin),
    "feat(checkout): pay by card",
  );
});

test("ignores closing references to other repositories and other GitHub pages", () => {
  const summary = [
    "Fixes https://github.com/acme/shop-docs/issues/1",
    "Fixes https://github.com/other/shop/issues/2",
    "Fixes [#10](https://github.com/other/shop/issues/10)",
    "Fixes https://github.com/acme/shop/pull/7",
    "Fixes https://gitlab.com/acme/shop/issues/8",
    `Fixes ${issue(0)}`,
    "Fixes other/shop#9",
  ].join("\n");
  assert.deepEqual(linkedIssueNumbers({ summary }, origin), []);
});

test("appends one Closes line per distinct issue, in number order", () => {
  const story = {
    title: `Pay by card, fixes ${issue(31)}`,
    summary: [
      `Fixes ${issue(31)}`,
      `Traite l'issue ${issue(4)}`,
      "Closes https://github.com/Acme/Shop/issues/4",
    ].join("\n"),
  };
  assert.equal(
    withLinkedIssueTrailers("feat(checkout): pay by card\n", story, origin),
    "feat(checkout): pay by card\n\nCloses #4\nCloses #31",
  );
});

test("leaves the message alone without a GitHub origin", () => {
  const story = { summary: `Fixes ${issue(12)}` };
  for (const url of [
    undefined,
    "",
    "git@gitlab.com:acme/shop.git",
    "/srv/git/shop.git",
  ]) {
    assert.deepEqual(linkedIssueNumbers(story, url), [], String(url));
    assert.equal(
      withLinkedIssueTrailers("fix: pay by card", story, url),
      "fix: pay by card",
      String(url),
    );
  }
});

test("adds only the issues the message doesn't close yet", () => {
  const story = { summary: `Fixes ${issue(12)}, fixes ${issue(31)}` };
  assert.equal(
    withLinkedIssueTrailers("feat: pay by card\n\nCloses #12", story, origin),
    "feat: pay by card\n\nCloses #12\nCloses #31",
  );
  assert.equal(
    withLinkedIssueTrailers(
      "feat: pay by card (fixes #12)\n\nResolves acme/shop#31",
      story,
      origin,
    ),
    "feat: pay by card (fixes #12)\n\nResolves acme/shop#31",
  );
  // Only GitHub's keywords on that exact issue close it from a commit.
  assert.equal(
    withLinkedIssueTrailers(
      "feat: pay by card, traite #12\n\nCloses #120\nCloses other/shop#31",
      story,
      origin,
    ),
    "feat: pay by card, traite #12\n\nCloses #120\nCloses other/shop#31\nCloses #12\nCloses #31",
  );
});

test("starts a new paragraph after a body that isn't closing lines", () => {
  const story = { summary: `Fixes ${issue(12)}` };
  assert.equal(
    withLinkedIssueTrailers(
      "feat: pay by card\n\nAdds the card form.",
      story,
      origin,
    ),
    "feat: pay by card\n\nAdds the card form.\n\nCloses #12",
  );
});
