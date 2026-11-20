import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectTestCommand } from "./test-client/units.js";
import type { TaskCatalogItem } from "./test-client/units.js";

const task = { cwd: ".", task_id: "test", script: "test", package_manager: "npm", kind: "test" } as TaskCatalogItem;
test("literal npm tests retain script and exact quoted argv", { skip: process.platform === "win32" }, () => {
  for (const command of ['npm test -- --run "space file.ts"', "npm run test -- --run 'space file.ts'"])
    assert.deepEqual(projectTestCommand(command, ".", [task]), {
      taskId: "test", taskKind: "test", args: ["--run", "space file.ts"],
    });
  assert.deepEqual(projectTestCommand("npm test -- '--test-name-pattern=foo.*' '$literal'", ".", [task]), {
    taskId: "test", taskKind: "test", args: ["--test-name-pattern=foo.*", "$literal"],
  });
  assert.deepEqual(projectTestCommand("npm run test:unit -- --run", "child", [
    { ...task, cwd: "child", task_id: "child:test:unit", script: "test:unit" },
  ]), { taskId: "child:test:unit", taskKind: "test", args: ["--run"] });
});

test("ambiguous scope, shell expansion, options and oversized selections remain unidentified", () => {
  for (const command of [
    'npm test -- "$FILE"', "npm test -- $(echo file.ts)", "npm test -- `echo file.ts`",
    "npm test -- *.ts", "npm test -- a\\ b.ts", "npm test -- a.ts && echo done",
    "npm test -- a.ts; echo done", "npm test -- a.ts | cat", "npm test -- a.ts > out",
    "npm test -- a.ts # comment", "X=1 npm test -- a.ts", "env npm test -- a.ts",
    "npm test -- a.ts &", "npm run test --run", "npm --prefix child test -- file.ts",
    "pnpm test -- file.ts", "node test/test.js", "npm run build -- file.ts",
    "npm test -- ''", 'npm test -- "a\\nb"', "npm test -- " + "a ".repeat(33),
    "npm test -- " + "a".repeat(2049), "npm test -- 'unterminated",
  ]) assert.equal(projectTestCommand(command, ".", [task]), undefined, command);
  assert.equal(projectTestCommand("npm test -- file.ts", "child", [task]), undefined);
  assert.equal(projectTestCommand("npm test -- file.ts", ".", [task, task]), undefined);
});

import { LightWorkspace } from "./test-client/light-workspace.js";
import { LightFinishService } from "./test-client/light-finish-service.js";
import { SessionJournal } from "./session-journal.js";

test("raw npm selected test is refreshed after final description edit and current build", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-npm-selection-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "node --check value.cjs" } }));
    await writeFile(join(root, "value.cjs"), "exports.value=1;\n");
    await writeFile(join(root, "selected suite.test.cjs"), "const {test}=require('node:test');const assert=require('node:assert/strict');const {value}=require('./value.cjs');\ntest('selected',()=>assert.equal(value,2));test('unrelated',()=>assert.fail('excluded'));\n");
    const workspace = new LightWorkspace(root, { sessionId: "npm-selection" });
    const patch = (path: string, before: string, after: string) => workspace.editCode({ operations: [
      { kind: "patch", path, patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n-${before}\n+${after}\n*** End Patch` },
    ] });
    await patch("value.cjs", "exports.value=1;", "exports.value=2;");
    const result = await workspace.runTask({ kind: "command", command: 'npm test -- --test-name-pattern=selected "selected suite.test.cjs"' }, {});
    assert.equal(result.status, "ok", JSON.stringify(result));
    const old = "test('selected',()=>assert.equal(value,2));test('unrelated',()=>assert.fail('excluded'));";
    assert.equal((await patch("selected suite.test.cjs", old, old.replace("'selected'", "'selected regression'"))).status, "ok");
    await workspace.runTask({ kind: "project", task: "build" }, {});
    const activities: unknown[] = [];
    const service = new LightFinishService({ conversationId: "npm-selection", workspaceRoot: root,
      onValidationActivity: value => { if (value.phase === "started") activities.push(value.input); } });
    await service.finish("done", {} as never);
    assert.deepEqual(activities, [{ kind: "project", task: "test", args: ["--test-name-pattern=selected", "selected suite.test.cjs"] }]);
    const final = await new SessionJournal(root, "npm-selection").completionSnapshot();
    const tests = final.validations.filter(v => v.taskKind === "test");
    assert.equal(tests.length, 1);
    assert.equal(tests[0]?.check?.counts?.executed, 1);
    assert.equal(tests[0]?.check?.outcome, "passed");
    assert.equal(tests[0]?.status, "unknown");
    assert.equal(tests[0]?.check?.selection, "unknown");
    assert.equal(tests[0]?.sourceRevisionId, final.sourceRevisionId);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("cmd.exe commands never acquire Bash-derived test identity", () => {
  assert.equal(projectTestCommand('npm test -- "space file.ts"', ".", [task], "win32"), undefined);
  assert.deepEqual(projectTestCommand('npm test -- "space file.ts"', ".", [task], "linux"), {
    taskId: "test", taskKind: "test", args: ["space file.ts"],
  });
});

test("a raw npm failure blocks completion despite a passing build", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-npm-failure-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "node --check value.cjs" } }));
    await writeFile(join(root, "value.cjs"), "exports.value=1;\n");
    await writeFile(join(root, "failed.test.cjs"), "require('node:test').test('failure',()=>require('node:assert/strict').fail('required regression'));\n");
    const workspace = new LightWorkspace(root, { sessionId: "npm-failure" });
    const edit = await workspace.editCode({ operations: [{ kind: "patch", path: "value.cjs",
      patch: "*** Begin Patch\n*** Update File: value.cjs\n@@\n-exports.value=1;\n+exports.value=2;\n*** End Patch" }] });
    assert.equal(edit.status, "ok");
    await workspace.runTask({ kind: "project", task: "build" }, {});
    await workspace.runTask({ kind: "command", command: "npm test -- failed.test.cjs" }, {});
    let completed = false;
    const service = new LightFinishService({ workspaceRoot: root, conversationId: "npm-failure",
      onComplete: () => { completed = true; } });
    await assert.rejects(service.finish("done", {} as never), /still failing/u);
    assert.equal(completed, false);
    const snapshot = await new SessionJournal(root, "npm-failure").completionSnapshot();
    assert.ok(snapshot.validations.some(v => v.taskKind === "test" && v.terminal === "failed" && v.category === "code"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
