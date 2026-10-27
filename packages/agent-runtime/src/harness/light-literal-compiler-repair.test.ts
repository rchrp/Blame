import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { data, fixture, LightWorkspace, LightFinishService } from "./light-agent-guidance-fixture.js";
import { failedLiteralCompilerInvocations } from "./light-check-repair.js";
import { SessionJournal } from "./session-journal.js";

const compiler = "node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json";
const files = { "package.json": JSON.stringify({ scripts: { test: "node --test suite.cjs" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, types: [] }, files: ["value.ts"] }),
  "value.ts": "export const value: number = 'bad';\n",
  "suite.cjs": "require('node:test').test('case',()=>{});\n" };

test("an unmatched literal compiler is repaired before green checks without replacing final obligations", async () => {
  await fixture(files, async (_, root) => {
    await mkdir(join(root, "node_modules"));
    await symlink(fileURLToPath(new URL("../../node_modules/typescript", import.meta.url)), join(root, "node_modules/typescript"));
    const contract = { session_id: "literal", required_checks: [{ id: "runtime", task: "test" }] };
    const workspace = new LightWorkspace(root, { sessionId: "literal", taskContract: contract });
    const failed = await workspace.runTask({ kind: "command", command: compiler }, {});
    assert.equal(failed.status, "blocked");
    assert.equal(failed.status === "blocked" && failed.category, "code");
    assert.equal(failed.status === "blocked" && JSON.parse(failed.recovery!.split("\n").at(-1)!).validationRepair.repairFirst[0].input.command, compiler);
    data(await workspace.runTask({ kind: "project", task: "test" }, {}));
    data(await workspace.editCode({ operations: [{ kind: "patch", path: "value.ts", patch: "*** Begin Patch\n*** Update File: value.ts\n@@\n-export const value: number = 'bad';\n+export const value: number = 2;\n*** End Patch" }] }));
    const order: unknown[] = [];
    const finish = new LightFinishService({ workspaceRoot: root, conversationId: "literal", taskContract: contract,
      onValidationActivity: item => { if (item.phase === "started") order.push(item.input); } });
    await finish.finish("Compilation passed; runtime obligation refreshed separately.", {} as never);
    assert.deepEqual(order, [{ kind: "command", command: compiler }, { kind: "project", task: "test", args: [] }]);
    const state = await new SessionJournal(root, "literal").completionSnapshot();
    const check = state.validations.find(value => value.command === compiler);
    assert.equal(check?.scope, "invocation_only");
    assert.deepEqual(check?.paths, []);
    assert.equal(check?.taskId, undefined);
    assert.equal(state.validations.some(value => value.taskId === "test" && value.check?.outcome === "passed"), true);
  });
});

test("compound shell, emit-enabled and expanded compiler commands are never replay candidates", () => {
  const entry = { id: "x", paths: [], files: [], status: "failed", terminal: "failed" as const,
    category: "code" as const, sourceRevisionId: "old", timestamp: "then", taskKind: "typecheck", cwd: ".", recovery: undefined, taskId: undefined, check: undefined };
  for (const command of [compiler + " || true", "tsc --noEmit; echo done", "tsc -p tsconfig.json", "tsc --noEmit -p $CONFIG", "node fake/typescript/bin/tsc --noEmit"])
    assert.deepEqual(failedLiteralCompilerInvocations([{ ...entry, command }]), []);
  assert.equal(failedLiteralCompilerInvocations([{ ...entry, command: compiler }]).length, 1);
  assert.deepEqual(failedLiteralCompilerInvocations([{ ...entry, command: compiler }, { ...entry, command: compiler, taskId: "now-catalogued", terminal: "passed" }]), []);
});
