import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { invocationTestReport } from "./invocation-test-report.js";
import { WorkspaceFiles } from "./workspace-files.js";
import { LightTaskRunner } from "./light-task-runner.js";
import { SessionJournal } from "./session-journal.js";

const jsonReport = (failed = false) => JSON.stringify({ numTotalTests: 1, numPassedTests: failed ? 0 : 1,
  numFailedTests: failed ? 1 : 0, numPendingTests: 0, numTodoTests: 0, success: !failed, testResults: [] });
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "blame-owned-vitest-"));
  try { await writeFile(join(root, ".gitignore"), ".blame/\nnode_modules/\n"); await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
for (const variant of ["passed", "missing_end", "mismatch", "malformed", "wrong_version", "outside", "failed", "zero"])
  test(`invocation-owned Vitest evidence: ${variant}`, async () => fixture(async root => {
    const managed = await invocationTestReport(root), directory = managed.environment.HARNESS_VITEST_REPORT_DIRECTORY;
    const files = new WorkspaceFiles(root), before = await files.snapshot();
    const id = "1234-abcd", start = { format: "blame-vitest-invocation-v1", id,
      runner: { name: "vitest", version: variant === "wrong_version" ? "4.0.0" : "3.2.4" },
      entry: "/node_modules/vitest/vitest.mjs", executable: process.execPath, cwd: root, args: ["run"] };
    await writeFile(join(directory, `${id}.start.json`), JSON.stringify(start));
    if (variant !== "missing_end") await writeFile(join(directory, `${id}.end.json`),
      JSON.stringify({ ...start, ...(variant === "mismatch" ? { cwd: "/elsewhere" } : {}), exitCode: variant === "failed" ? 1 : 0 }));
    const report = JSON.parse(jsonReport(variant === "failed"));
    report.testResults = [{ name: join(root, "case.test.ts"), assertionResults: [{status: variant === "failed" ? "failed" : "passed"}] }];
    if (variant === "outside") report.testResults = [{ name: "/outside.test.ts", assertionResults: [{}] }];
    if (variant === "zero") Object.assign(report, { numTotalTests: 0, numPassedTests: 0, testResults: [] });
    await writeFile(join(directory, `${id}.report.json`), variant === "malformed" ? "{" : JSON.stringify(report));
    const observed = await managed.read(before, await files.snapshot());
    assert.equal(Boolean(observed), ["passed", "failed", "zero"].includes(variant));
    if (observed) {
      assert.equal(observed.report.counts.executed, variant === "zero" ? 0 : 1);
      assert.equal(observed.report.counts.failed, variant === "failed" ? 1 : 0);
      assert.equal(observed.evidence.typeFileSelection, "unknown");
    }
  }));

const dependencies = process.env.BLAME_TEST_VITEST_DEPENDENCIES;
for (const maskedFailure of [false, true, "empty", "bin", "setup"]) test(`real Vitest behind Node wrapper, maskedFailure=${maskedFailure}`,
  { skip: !dependencies && "Set BLAME_TEST_VITEST_DEPENDENCIES to pinned Vitest 3.2.4 dependencies" },
  async () => fixture(async root => {
    await symlink(join(dependencies!, "node_modules"), join(root, "node_modules"));
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { "test:wrapped": maskedFailure === "bin" ? "vitest run case.test.ts --maxWorkers=1 --fileParallelism=false" : "node wrapper.mjs" } }));
    await writeFile(join(root, "case.test.ts"), `${maskedFailure === 'setup' ? "import './missing.ts';" : ''}import {test,expect} from 'vitest'; test('actual',()=>expect(1).toBe(${maskedFailure === true ? 2 : 1}));\n`);
    await writeFile(join(root, "wrapper.mjs"), `import {spawnSync} from 'node:child_process'; spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',${JSON.stringify(maskedFailure === 'empty' ? 'absent.test.ts' : 'case.test.ts')},'--maxWorkers=1','--fileParallelism=false'],{stdio:'inherit'}); process.exitCode=0;\n`);
    const files = new WorkspaceFiles(root), journal = new SessionJournal(root, "owned-vitest");
    const tasks = new LightTaskRunner({ files, journal });
    const result = await tasks.run({ kind: "project", task: "test:wrapped" }, {});
    assert.equal(result.status, "ok", JSON.stringify(result));
    const check = (await journal.completionSnapshot()).validations.at(-1)!;
    assert.equal(check.check?.exitCode, 0);
    assert.equal(check.check?.outcome, maskedFailure === "empty" ? "unknown" : maskedFailure === true || maskedFailure === "setup" ? "failed" : "passed", JSON.stringify(result));
    assert.equal(check.check?.evidenceOrigin, "vitest_report");
    assert.equal(check.check?.counts?.executed, maskedFailure === "empty" || maskedFailure === "setup" ? 0 : 1);
    assert.equal(check.status, maskedFailure === true || maskedFailure === "setup" ? "failed" : "unknown");
    const evidence = check.check!.evidence as { invocations: { files: { path: string; unchanged: boolean }[] }[] };
    if (maskedFailure !== "empty") {
    assert.equal(evidence.invocations[0]?.files[0]?.path, "case.test.ts");
    assert.equal(evidence.invocations[0]?.files[0]?.unchanged, true);
    }
    assert.equal(await readFile(join(root, "wrapper.mjs"), "utf8").then(text => text.includes("--reporter")), false);
  }));
