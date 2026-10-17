import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { LightWorkspace } from "./light-workspace.js";
import { lightDefaultRunTaskInputSchema, lightRunTaskInputSchema } from "./light-contracts.js";

const solver = process.env.BLAME_Z3_PATH ?? "z3";
const available = spawnSync(solver, ["-version"], { timeout: 1_000 }).status === 0;
const source = "export function remaining(capacity: number, used: number) { if (used > capacity) return 0; return capacity + used; }\n";
const input = { kind: "analyze" as const, target: "budget.ts#remaining",
  inputs: { capacity: { min: 0, max: 100 }, used: { min: 0, max: 100 } },
  assertion: "result === (used > capacity ? 0 : capacity - used)" };

async function fixture(run: (workspace: LightWorkspace, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "blame-symbolic-workspace-"));
  try {
    await writeFile(join(root, "budget.ts"), source);
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    await run(new LightWorkspace(root, { sessionId: "symbolic-integration" }), root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("symbolic task schema is opt-in without changing ordinary command forms", () => {
  assert.equal(lightRunTaskInputSchema.safeParse(input).success, true);
  assert.equal(lightDefaultRunTaskInputSchema.safeParse(input).success, false);
  for (const value of [{ command: "pwd" }, { kind: "command", command: "pwd" },
    { kind: "project", task: "test" }, { kind: "inspect", run: "r1" }])
    assert.equal(lightDefaultRunTaskInputSchema.safeParse(value).success, true);
  for (const values of [{ min: 2, max: 1 }, { min: NaN, max: 3 }, { min: 0, max: Infinity }, { min: 0.5, max: 3 }])
    assert.equal(lightRunTaskInputSchema.safeParse({ ...input, inputs: { capacity: values } }).success, false);
});

test("Z3 witness from run_task reproduces in real JavaScript and does not admit checks or edits", { skip: !available }, async () => {
  await fixture(async (workspace, root) => {
    const result = await workspace.runTask(input, {});
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const data = result.data as { status: string; witness: { inputs: { capacity: number; used: number }; result: number }; validationAdmission: boolean; sourceRevisionId: string };
    assert.equal(data.status, "counterexample");
    assert.equal(data.validationAdmission, false);
    assert.ok(data.sourceRevisionId);
    const js = ts.transpile(source.replace("export ", ""));
    const { capacity, used } = data.witness.inputs;
    const real = runInNewContext(`${js}\nremaining(${capacity}, ${used});`, {}, { timeout: 1_000 });
    assert.equal(real, data.witness.result);
    assert.notEqual(real, used > capacity ? 0 : capacity - used);
    const checks = await workspace.readCode({ target: "@checks" }, {});
    assert.equal(checks.status, "ok");
    if (checks.status === "ok") assert.equal((checks.data as { total: number }).total, 0);
    assert.equal(await readFile(join(root, "budget.ts"), "utf8"), source);
    assert.equal((await workspace.editCode({ operations: [{ kind: "symbol", target: input.target,
      action: "replace_body", content: "return 0;" }] })).status, "blocked");
  });
});

test("analysis rejects source changed while solver runs", async () => {
  await fixture(async (workspace, root) => {
    const fake = join(root, "solver.cjs");
    const target = join(root, "budget.ts");
    await writeFile(fake, `#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv.includes('-version')){fs.appendFileSync(${JSON.stringify(target)},'// external change\\n');console.log('Z3 version 4.15.4 - 64 bit');}else{process.stdin.once('data',()=>{console.log('unsat');process.exit(0);});}\n`);
    await chmod(fake, 0o755);
    const prior = process.env.BLAME_Z3_PATH;
    process.env.BLAME_Z3_PATH = fake;
    try {
      const result = await workspace.runTask(input, {});
      assert.equal(result.status, "ok");
      if (result.status === "ok") {
        assert.equal((result.data as { reason: string }).reason, "source_changed");
        assert.equal((result.data as { status: string }).status, "unknown");
        assert.equal((result.data as { witness?: unknown }).witness, undefined);
      }
    } finally {
      if (prior === undefined) delete process.env.BLAME_Z3_PATH; else process.env.BLAME_Z3_PATH = prior;
    }
  });
});

test("analysis target ambiguity and pre-cancellation produce no positive evidence", async () => {
  await fixture(async (workspace, root) => {
    const missing = await workspace.runTask({ ...input, target: "budget.ts#missing" }, {});
    assert.equal(missing.status, "blocked");
    await assert.rejects(workspace.runTask(input, { signal: AbortSignal.abort(new Error("stop analysis")) }), /stop analysis/);
    await writeFile(join(root, "budget.ts"), source + source.replace("export ", ""));
    const duplicate = await workspace.runTask(input, {});
    assert.equal(duplicate.status, "blocked");
  });
});

test("TypeScript-only semantics cannot be admitted for an untyped JavaScript target", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(join(root, "budget.js"), "export function remaining(capacity, used) { return capacity + used; }\n");
    const result = await workspace.runTask({ ...input, target: "budget.js#remaining" }, {});
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") assert.match(result.message, /typed TypeScript/);
  });
});
