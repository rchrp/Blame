import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { LightCompletionNotification } from "./light-completion.js";
const prefix = process.env.BLAME_COMPILER_RUNTIME;
const { LightWorkspace } = await import(prefix ? `${prefix}/light-workspace.js` : "./light-workspace.js") as typeof import("./light-workspace.js");
const { LightFinishService } = await import(prefix ? `${prefix}/light-finish-service.js` : "./light-finish-service.js") as typeof import("./light-finish-service.js");
const { readTaskCatalog } = await import(prefix ? `${prefix}/task-catalog.js` : "./task-catalog.js") as typeof import("./task-catalog.js");
const command = "node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json";
async function fixture(run: (root: string, workspace: InstanceType<typeof LightWorkspace>) => Promise<void>, options: { script?: string; badSource?: boolean; badPost?: boolean; taskName?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "blame-compiler-check-"));
  try {
    await mkdir(join(root, "node_modules")); await mkdir(join(root, ".blame"));
    await symlink(fileURLToPath(new URL("../../node_modules/@typescript/native", import.meta.url)), join(root, "node_modules/typescript"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      ["pre" + (options.taskName ?? "test:study:types")]: "node hook.cjs pre", [options.taskName ?? "test:study:types"]: options.script ?? command,
      ["post" + (options.taskName ?? "test:study:types")]: options.badPost ? "node hook.cjs post && node -e 'process.exit(7)'" : "node hook.cjs post",
      "test:unit": "node --test suite.cjs",
    } }));
    await writeFile(join(root, "hook.cjs"), "require('node:fs').appendFileSync('.blame/hooks.log', process.argv[2]+'\\n');\n");
    await writeFile(join(root, "value.ts"), options.badSource ? "export const count: number = 'bad';\n" : "export const count: number = 1;\n");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [] }, files: ["value.ts"] }));
    await writeFile(join(root, "suite.cjs"), "require('node:test')('case',()=>require('node:assert/strict').equal(1,1));\n");
    await run(root, new LightWorkspace(root, { sessionId: "compiler-check" }));
  } finally { await rm(root, { recursive: true, force: true }); }
}
function data(result: Awaited<ReturnType<InstanceType<typeof LightWorkspace>["runTask"]>>) {
  assert.equal(result.status, "ok", JSON.stringify(result));
  return (result as { data: { command: string; exitCode: number; validation?: { status?: string }; reporting?: { counts: { passed: number | null } } } }).data;
}
async function checks(workspace: InstanceType<typeof LightWorkspace>) {
  const result = await workspace.readCode({ target: "@checks" }, {});
  assert.equal(result.status, "ok");
  return (result as { data: { checks: { task: string; status: string; admission: string; reporting: unknown; scope?: string }[] } }).data.checks;
}
const check = (workspace: InstanceType<typeof LightWorkspace>) => workspace.runTask({ kind: "project", task: "test:study:types" }, {});

test("compiler-only no-emit scripts take precedence over a test-like name", async () => {
  await fixture(async root => {
    assert.equal((await readTaskCatalog(root)).find(task => task.task_id === "test:study:types")?.kind, "typecheck");
  });
});
test("successful compiler execution preserves npm hooks and admits the required compiler check without test counts", async () => {
  await fixture(async (root, workspace) => {
    const result = data(await check(workspace));
    assert.equal(result.command, "npm run test:study:types"); assert.equal(result.exitCode, 0);
    assert.equal(result.validation?.status, "passed"); assert.equal(result.reporting, undefined);
    assert.equal(await readFile(join(root, ".blame/hooks.log"), "utf8"), "pre\npost\n");
    const records = await checks(workspace); const record = records.find(item => item.task === "test:study:types");
    assert.equal(record?.admission, "admitted"); assert.equal(record.reporting, null);
    assert.equal(record.scope, "invocation_only");
    const notifications: LightCompletionNotification[] = [];
    const finish = new LightFinishService({ workspaceRoot: root, conversationId: "compiler-check", onComplete: value => { notifications.push(value); },
      taskContract: { session_id: "compiler-check", required_checks: [{ id: "types", task: "test:study:types" }] } });
    await finish.finish("Compiler check passed; runtime behavior remains a separate assessment.", {} as never);
    assert.equal(notifications.at(-1)?.verified, true);
    assert.ok(notifications.at(-1)?.completion?.satisfied_obligations.includes("check:types"));
  });
});
test("a failing compiler never becomes an admitted passing check", async () => {
  await fixture(async (_root, workspace) => {
    await check(workspace);
    const record = (await checks(workspace)).find(item => item.task === "test:study:types");
    assert.equal(record?.status, "failed"); assert.equal(record.admission, "unverified");
  }, { badSource: true });
});
test("a failed post hook keeps the npm invocation failed despite a successful compiler", async () => {
  await fixture(async (root, workspace) => {
    await check(workspace);
    assert.equal(await readFile(join(root, ".blame/hooks.log"), "utf8"), "pre\npost\n");
    const record = (await checks(workspace)).find(item => item.task === "test:study:types");
    assert.equal(record?.status, "failed"); assert.equal(record.admission, "unverified");
  }, { badPost: true });
});
test("changing source after compilation invalidates its current-source admission", async () => {
  await fixture(async (root, workspace) => {
    await check(workspace); assert.equal((await checks(workspace)).find(item => item.task === "test:study:types")?.admission, "admitted");
    await writeFile(join(root, "value.ts"), "export const count: number = 'changed';\n");
    assert.ok((await checks(workspace)).every(item => item.admission !== "admitted"));
  });
});
test("a compiler error hidden by a compound command stays unverified", async () => {
  await fixture(async (_root, workspace) => {
    assert.equal((await readTaskCatalog(_root)).find(task => task.task_id === "test:study:types")?.kind, "test");
    await check(workspace);
    assert.ok((await checks(workspace)).every(item => item.admission !== "admitted"));
  }, { badSource: true, script: command + " || true" });
});
test("real Node tests retain their observed test counters", async () => {
  await fixture(async (_root, workspace) => {
    const result = data(await workspace.runTask({ kind: "project", task: "test:unit" }, {}));
    assert.equal(result.reporting?.counts.passed, 1);
  });
});
test("lookalikes, expanded and composite compiler commands do not become compiler-only checks", async () => {
  for (const script of ["node fake/typescript/bin/tsc --noEmit", command + " && node --test suite.cjs", "tsc --noEmit; true", "tsc --noEmit -p $CONFIG"]) {
    await fixture(async root => {
      assert.equal((await readTaskCatalog(root)).find(task => task.task_id === "test:study:types")?.kind, "test", script);
    }, { script });
  }
});

test("a newly recognized compiler invocation cannot verify a changed file excluded by its project", async () => {
  await fixture(async (root, workspace) => {
    const changed = await workspace.editCode({ operations: [{ kind: "patch", path: "excluded.ts", patch: "export const excluded: number = 'not compiled';\n" }] });
    assert.equal(changed.status, "ok", JSON.stringify(changed));
    data(await check(workspace));
    const notifications: LightCompletionNotification[] = [];
    const finish = new LightFinishService({ workspaceRoot: root, conversationId: "compiler-check", onComplete: value => { notifications.push(value); },
      taskContract: { session_id: "compiler-check", required_checks: [{ id: "types", task: "test:study:types" }] } });
    await finish.finish("The compiler invocation passed; excluded source is not verified.", {} as never);
    assert.equal(notifications.at(-1)?.verified, false);
    assert.ok(notifications.at(-1)?.completion.satisfied_obligations.includes("check:types"));
  });
});

for (const [taskName, script] of [["typecheck", command], ["check:types", "node -e 'process.exit(0)'"]]) {
  test(`${taskName} does not infer file coverage from its name or exit status`, async () => {
    await fixture(async (root, workspace) => {
      assert.equal((await workspace.editCode({ operations: [{ kind: "patch", path: "excluded.test.ts", patch: "export const broken: number = 'unchecked';\n" }] })).status, "ok");
      data(await workspace.runTask({ kind: "project", task: taskName! }, {}));
      const record = (await checks(workspace)).find(item => item.task === taskName);
      assert.equal(record?.scope, "invocation_only");
      assert.equal(record?.admission, "admitted"); // Execution, never file coverage.
      const notifications: LightCompletionNotification[] = [];
      const finish = new LightFinishService({ workspaceRoot: root, conversationId: "compiler-check", onComplete: value => { notifications.push(value); },
        taskContract: { session_id: "compiler-check", required_checks: [{ id: "types", task: taskName! }] } });
      await finish.finish("Execution succeeded; source coverage is unknown.", {} as never);
      assert.equal(notifications.at(-1)?.verified, false);
      assert.ok(notifications.at(-1)?.completion.satisfied_obligations.includes("check:types"));
    }, { taskName, script });
  });
}
