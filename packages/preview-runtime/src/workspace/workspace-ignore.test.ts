import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWorkspaceSnapshotPolicy,
  WorkspaceIgnore,
} from "./workspace-ignore.js";

function portfolioRules() {
  const rules = new WorkspaceIgnore("gitignore-v1");
  rules.add("", "**/.next/\n*.tsbuildinfo\n.env*\n!.env.example\n");
  rules.add(
    "apps/web",
    "next-env.d.ts\n/src/generated/prisma/\n/build\n!keep.tsbuildinfo\n",
  );
  return rules;
}

test("skips files that a running app generates", () => {
  const rules = portfolioRules();
  assert.equal(rules.ignores("apps/web/next-env.d.ts"), true);
  assert.equal(rules.ignores("apps/web/tsconfig.tsbuildinfo"), true);
  assert.equal(rules.ignores("apps/web/src/generated/prisma", true), true);
  assert.equal(
    rules.ignoresWithAncestors("apps/web/src/generated/prisma/client.ts"),
    true,
  );
  assert.equal(rules.ignores("apps/web/build", true), true);
});

test("keeps source files, negations and anchored names elsewhere", () => {
  const rules = portfolioRules();
  assert.equal(rules.ignores("apps/web/src/app/page.tsx"), false);
  assert.equal(rules.ignores(".env.example"), false);
  assert.equal(rules.ignores("apps/web/keep.tsbuildinfo"), false);
  assert.equal(rules.ignores("src/generated/prisma", true), false);
  assert.equal(rules.ignores("next-env.d.ts"), false);
  assert.equal(rules.ignores("apps/web/build.ts"), false);
});

test("a .gitignore file is always synchronized", () => {
  const rules = new WorkspaceIgnore("gitignore-v1");
  rules.add("", ".*\n");
  assert.equal(rules.ignores(".gitignore"), false);
  assert.equal(rules.ignores(".github", true), true);
});

test("matching is case-sensitive like Git on Linux", () => {
  const rules = new WorkspaceIgnore("gitignore-v1");
  rules.add("", "Build/\n");
  assert.equal(rules.ignores("Build", true), true);
  assert.equal(rules.ignores("build", true), false);
});

test("nested rules apply only below their directory", () => {
  const rules = new WorkspaceIgnore("gitignore-v1");
  rules.add("./.github/", "*.log\n");
  rules.add("", "!important.log\n");
  assert.equal(rules.ignores(".github/run.log"), true);
  assert.equal(rules.ignores("run.log"), false);
});

test("the legacy policy skips nothing", () => {
  const rules = new WorkspaceIgnore("legacy");
  rules.add("", "*\n");
  assert.equal(rules.ignoresWithAncestors("src/index.ts"), false);
  assert.equal(parseWorkspaceSnapshotPolicy(undefined), "legacy");
  assert.equal(parseWorkspaceSnapshotPolicy("gitignore-v1"), "gitignore-v1");
});
