import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  projectCodePracticesPrompt,
  projectCodePracticesResultSchema,
  resolveProjectCodePracticesResult,
} from "./project-code-practices.js";
import { scanProjectCodePractices } from "./project-code-practices-scan.js";

const practices = {
  unit_tests: { detected: true, comment: "Tests are configured." },
  coding_style: {
    detected: false,
    comment: "Strict linting is not configured.",
  },
  commit_message_convention: {
    detected: true,
    comment: "Recent commits use Conventional Commits.",
  },
  layered_architecture: {
    detected: false,
    comment: "Dependency boundaries are not enforced.",
  },
};

test("gives every required practice, in order, from the keyed result", () => {
  const result = resolveProjectCodePracticesResult(
    { projectState: "established", practices },
    commitEvidence(0, 0),
  );

  assert.deepEqual(
    result.map(({ practice }) => practice),
    [
      "coding_style",
      "unit_tests",
      "layered_architecture",
      "commit_message_convention",
    ],
  );
  assert.equal(result[0]!.comment, "Strict linting is not configured.");
});

test("the schema names each practice once and makes a starter adopt them all", () => {
  const schema = projectCodePracticesResultSchema;
  assert.deepEqual(schema.properties.practices.required, [
    "coding_style",
    "unit_tests",
    "layered_architecture",
    "commit_message_convention",
  ]);
  assert.equal(schema.properties.practices.additionalProperties, false);
  const starter = schema.anyOf[1]!.properties as {
    projectState: unknown;
    practices: { properties: Record<string, { properties: unknown }> };
  };
  assert.deepEqual(starter.projectState, { const: "starter" });
  assert.deepEqual(starter.practices.properties.unit_tests!.properties, {
    detected: { const: true },
    comment: { type: "string", minLength: 1 },
  });
  // Only keywords the engine checks.
  assert.doesNotMatch(
    JSON.stringify(schema),
    /"(?:pattern|minProperties|maxProperties|\$ref|contains)"/,
  );
});

test("detects the commit convention when conventional commits are the majority", () => {
  const result = resolveProjectCodePracticesResult(
    { projectState: "established", practices },
    commitEvidence(36, 40),
  );
  const convention = result.find(
    ({ practice }) => practice === "commit_message_convention",
  );

  assert.equal(convention?.detected, true);
  assert.equal(
    convention?.comment,
    "36 of 40 evaluated commits use Conventional Commits, so the majority follows the convention.",
  );
});

test("does not detect the commit convention without a strict majority", () => {
  const result = resolveProjectCodePracticesResult(
    { projectState: "established", practices },
    commitEvidence(20, 40),
  );
  const convention = result.find(
    ({ practice }) => practice === "commit_message_convention",
  );

  assert.equal(convention?.detected, false);
});

for (const evaluatedCount of [0, 1]) {
  test(`preserves the analyst's starter defaults with ${evaluatedCount} non-conventional scaffold commits`, () => {
    const comment =
      "Only template code is present; adopt the professional standard for future work.";
    const starterPractices = Object.fromEntries(
      Object.keys(practices).map((practice) => [
        practice,
        { detected: true, comment },
      ]),
    );
    const result = resolveProjectCodePracticesResult(
      { projectState: "starter", practices: starterPractices },
      commitEvidence(0, evaluatedCount),
    );

    assert.equal(result.length, 4);
    assert.ok(result.every(({ detected }) => detected));
    assert.ok(result.every((practice) => practice.comment === comment));
  });
}

test("does not infer a starter from a short commit history", () => {
  const result = resolveProjectCodePracticesResult(
    { projectState: "established", practices },
    commitEvidence(0, 1),
  );
  assert.equal(
    result.find(({ practice }) => practice === "commit_message_convention")
      ?.detected,
    false,
  );
  assert.equal(
    result.find(({ practice }) => practice === "layered_architecture")
      ?.detected,
    false,
  );
});

test("refuses a result missing a practice", () => {
  const { unit_tests: _missing, ...incomplete } = practices;
  assert.throws(
    () =>
      resolveProjectCodePracticesResult(
        { projectState: "established", practices: incomplete },
        commitEvidence(0, 0),
      ),
    /missing unit_tests/,
  );
});

test("scans nested manifests, configurations, tests, and source evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "blame-code-practices-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeProjectFixture(root, {
    "package.json": JSON.stringify({ scripts: { test: "pnpm -r test" } }),
    "packages/api/package.json": JSON.stringify({
      scripts: { test: "node --test" },
    }),
    "packages/api/eslint.config.js":
      "export default [{ rules: { eqeqeq: 'error' } }]",
    "packages/api/src/application/create-order-service.ts":
      "export function createOrder() { return { id: 'order' } }",
    "packages/api/src/application/create-order-service.test.ts":
      "import test from 'node:test'; test('creates an order', () => {})",
    "packages/web/src/button.spec.tsx": "export const buttonTest = true",
    "packages/web/src/button.tsx":
      "export function Button() { return <button /> }",
  });

  const scan = await scanProjectCodePractices(root);

  assert.equal(scan.tests.fileCount, 2);
  assert.ok(
    scan.tests.paths.includes(
      "packages/api/src/application/create-order-service.test.ts",
    ),
  );
  assert.ok("packages/api/package.json" in scan.manifests);
  assert.ok("packages/api/eslint.config.js" in scan.configurations);
  assert.ok(
    scan.inventory.architecturePaths.includes(
      "packages/api/src/application/create-order-service.ts",
    ),
  );
  assert.ok(
    scan.source.representativePaths.includes("packages/web/src/button.tsx"),
  );
  assert.match(projectCodePracticesPrompt(scan), /"fileCount":2/);
});

async function writeProjectFixture(
  root: string,
  files: Record<string, string>,
) {
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }),
  );
}

function commitEvidence(conventionalCount: number, evaluatedCount: number) {
  return {
    conventionalCount,
    evaluatedCount,
    conventionalRatio: evaluatedCount
      ? conventionalCount / evaluatedCount
      : null,
    messages: [],
    nonConventionalMessages: [],
  };
}
