import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  diagnosticsBrief,
  collectProjectInitializationImpactDiagnostics,
  deterministicInitializationImpact,
  parseProjectInitializationImpactResult,
  type AssessProjectInitializationImpactInput,
} from "./project-initialization-impact.js";

const execFileAsync = promisify(execFile);

test("classifies UI-only diffs as initialization still valid before agent assessment", async () => {
  const repository = await repositoryFixture();
  try {
    const baseCommit = await commit(repository, "base");
    await mkdir(join(repository, "src"), { recursive: true });
    await writeFile(
      join(repository, "src", "Button.tsx"),
      "export function Button() { return <button /> }\n",
    );
    const mergeCommit = await commit(repository, "ui");
    const diagnostics = await diagnosticsFor(
      repository,
      baseCommit,
      mergeCommit,
    );
    const result = deterministicInitializationImpact(diagnostics);
    assert.equal(result?.classification, "initialization_still_valid");
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("collects an added apps api package as a relevant initialization diff", async () => {
  const repository = await repositoryFixture();
  try {
    const baseCommit = await commit(repository, "base");
    await mkdir(join(repository, "apps/api"), { recursive: true });
    await writeFile(
      join(repository, "apps/api/package.json"),
      JSON.stringify({ scripts: { dev: "tsx src/server.ts" } }),
    );
    const mergeCommit = await commit(repository, "api");
    const diagnostics = await diagnosticsFor(
      repository,
      baseCommit,
      mergeCommit,
    );
    assert.ok(diagnostics.relevantDiffs["apps/api/package.json"]);
    assert.equal(deterministicInitializationImpact(diagnostics), undefined);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("collects removed packages referenced by compose as relevant initialization diffs", async () => {
  const repository = await repositoryFixture({
    "services/worker/package.json": JSON.stringify({
      scripts: { dev: "node worker.js" },
    }),
  });
  try {
    const baseCommit = await commit(repository, "base");
    await git(repository, ["rm", "services/worker/package.json"]);
    const mergeCommit = await commit(repository, "remove worker");
    const diagnostics = await diagnosticsFor(
      repository,
      baseCommit,
      mergeCommit,
    );
    assert.ok(diagnostics.relevantDiffs["services/worker/package.json"]);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("collects dev script changes as relevant initialization diffs", async () => {
  const repository = await repositoryFixture({
    "apps/web/package.json": JSON.stringify({
      scripts: { dev: "vite --host 0.0.0.0" },
    }),
  });
  try {
    const baseCommit = await commit(repository, "base");
    await writeFile(
      join(repository, "apps/web/package.json"),
      JSON.stringify({ scripts: { dev: "next dev -H 0.0.0.0" } }),
    );
    const mergeCommit = await commit(repository, "dev script");
    const diagnostics = await diagnosticsFor(
      repository,
      baseCommit,
      mergeCommit,
    );
    assert.ok(diagnostics.relevantDiffs["apps/web/package.json"]);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("collects env template changes as relevant initialization diffs", async () => {
  const repository = await repositoryFixture({
    ".env.example": "DATABASE_URL=postgres://localhost/app\n",
  });
  try {
    const baseCommit = await commit(repository, "base");
    await writeFile(
      join(repository, ".env.example"),
      "DATABASE_URL=postgres://localhost/app\nREDIS_URL=redis://localhost:6379\n",
    );
    const mergeCommit = await commit(repository, "env template");
    const diagnostics = await diagnosticsFor(
      repository,
      baseCommit,
      mergeCommit,
    );
    assert.ok(diagnostics.relevantDiffs[".env.example"]);
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("parses update-required impact result", () => {
  const result = parseProjectInitializationImpactResult({
    classification: "initialization_update_required",
    reason: "The API service was added.",
    repairInstruction: "Regenerate compose with the API service.",
  });
  assert.equal(result.classification, "initialization_update_required");
  assert.equal(
    result.repairInstruction,
    "Regenerate compose with the API service.",
  );
});

test("parses unknown without repair instruction", () => {
  const result = parseProjectInitializationImpactResult({
    classification: "unknown",
    reason: "The diff is inconclusive.",
  });
  assert.deepEqual(result, {
    classification: "unknown",
    reason: "The diff is inconclusive.",
  });
});

async function repositoryFixture(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "blame-impact-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { dev: "vite" } }),
  );
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function diagnosticsFor(
  repository: string,
  baseCommit: string,
  mergeCommit: string,
) {
  return collectProjectInitializationImpactDiagnostics(
    input(repository, baseCommit, mergeCommit),
  );
}

function input(
  repository: string,
  baseCommit: string,
  mergeCommit: string,
): AssessProjectInitializationImpactInput {
  return {
    cwd: repository,
    baseCommit,
    mergeCommit,
    previewManifest: {
      confidence: "high",
      project: { root: "." },
      setup: [],
      services: [
        {
          id: "web",
          kind: "preview",
          container: { image: "node:22-bookworm" },
          command: "pnpm dev",
          endpoints: [
            {
              id: "http",
              protocol: "http",
              port: 3000,
              healthcheck: { type: "http", path: "/", timeoutMs: 30_000 },
            },
          ],
        },
      ],
      caches: [],
      risks: [],
      probes: [],
    },
    runConfigurations: [],
  };
}

async function commit(repository: string, message: string) {
  await git(repository, ["add", "-A"]);
  await git(repository, ["commit", "-m", message]);
  return git(repository, ["rev-parse", "HEAD"]);
}

async function git(repository: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd: repository });
  return stdout.trim();
}

test("the brief lists runtime files first and drops content the full diff gives", () => {
  const others = Array.from({ length: 2_000 }, (_, index) => `packages/app/src/view-${index}.tsx`);
  const diagnostics = {
    baseCommit: "a",
    mergeCommit: "b",
    changedFiles: [...others, "package.json", "pnpm-lock.yaml"],
    diffSummary: "",
    relevantDiffs: { "package.json": "+  \"dev\": \"vite\"", "pnpm-lock.yaml": "x".repeat(18_000) },
    currentPreviewManifest: {} as never,
    currentRunConfigurations: [],
    strategicFilesBefore: { "package.json": "{}", "pnpm-lock.yaml": "lock" },
    strategicFilesAfter: { "package.json": "{ \"dev\": \"vite\" }", "pnpm-lock.yaml": "lock 2" },
  };
  const brief = diagnosticsBrief(diagnostics);
  assert.equal(brief.changedFiles.length, 300);
  assert.deepEqual(brief.changedFiles.slice(0, 2), ["package.json", "pnpm-lock.yaml"]);
  assert.equal(brief.changedFilesNotListed, 1_702);
  // package.json's whole diff is there; the lockfile's was cut at 18,000.
  assert.deepEqual(brief.strategicFilesBefore, { "pnpm-lock.yaml": "lock" });
  assert.deepEqual(brief.strategicFilesAfter, diagnostics.strategicFilesAfter);
  const small = diagnosticsBrief({ ...diagnostics, changedFiles: ["package.json"] });
  assert.deepEqual(small.changedFiles, ["package.json"]);
  assert.equal("changedFilesNotListed" in small, false);
});
