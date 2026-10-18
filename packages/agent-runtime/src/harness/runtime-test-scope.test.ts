import assert from "node:assert/strict";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { data, fixture } from "./light-agent-guidance-fixture.js";
import { runtimeTestScope } from "./runtime-test-scope.js";
import { observeCheck } from "./check-observation.js";

test("a wrapper's types argument can repeat runtime while changed tests still fail compilation", async () => {
  await fixture({
    "package.json": JSON.stringify({ scripts: {
      "test:delivered": "node wrapper.cjs runtime",
      "typecheck:delivered": "node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json",
    } }),
    "wrapper.cjs": "require('node:fs').writeFileSync('.blame/mode.txt',process.argv[2]);require('node:child_process').execFileSync(process.execPath,['--test','suite.cjs'],{stdio:'inherit'});\n",
    "suite.cjs": "require('node:test')('active case',()=>{});\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ["*.test.ts"] }),
  }, async (workspace, root) => {
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(fileURLToPath(new URL("../../node_modules/typescript", import.meta.url)), join(root, "node_modules/typescript"));
    await workspace.editCode({ operations: [{ kind: "patch", path: "new.test.ts", patch: "export const wrong: number = 'not compiled by runtime';\n" }] });
    const result = data(await workspace.runTask({ kind: "project", task: "test:delivered", args: ["types"] }, {}));
    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(join(root, ".blame/mode.txt"), "utf8"), "runtime");
    assert.equal(result.testValidationScope.declaredScript, "node wrapper.cjs runtime");
    assert.deepEqual(result.testValidationScope.forwardedArgs, ["types"]);
    assert.equal(result.testValidationScope.testCompilation, "not_established");
    assert.deepEqual(result.testValidationScope.changedTypeScriptTests, ["new.test.ts"]);
    assert.deepEqual(result.testValidationScope.nextTypecheckSelections[0].input, { kind: "project", task: "typecheck:delivered" });
    const compiler = await workspace.runTask({ kind: "project", task: "typecheck:delivered" }, {});
    assert.equal(compiler.status, "blocked");
    assert.match(JSON.stringify(compiler), /TS2322/);
  });
});

test("ordinary runtime tests without changed TS tests or extra argv add no scope receipt", async () => {
  await fixture({
    "package.json": JSON.stringify({ scripts: { test: "node --test suite.cjs" } }),
    "suite.cjs": "require('node:test')('case',()=>{});\n",
  }, async workspace => {
    const result = data(await workspace.runTask({ kind: "project", task: "test" }, {}));
    assert.equal(result.testValidationScope, undefined);
  });
});

test("scope hints preserve real catalog cwd and cannot infer test membership or admission", () => {
  const check = observeCheck("node --test suite.cjs", { all: "# tests 1\n# pass 1\n# fail 0\n", exitCode: 0, failed: false, interruption: undefined } as never, ".", false);
  const scope = runtimeTestScope({ check, args: ["types"], changedPaths: ["src/new.test.ts", "src/value.ts"],
    typecheckSelections: [{ task: "pkg:typecheck", cwd: "packages/pkg" }] })!;
  assert.equal(scope.testCompilation, "not_established");
  assert.deepEqual(scope.nextTypecheckSelections[0]!.input, { kind: "project", task: "pkg:typecheck", packagePath: "packages/pkg" });
  assert.equal(scope.nextTypecheckSelections[0]!.coverage, "inspect_configuration");
  assert.equal("admission" in scope, false);
  assert.equal(scope.changedTestCount, 1);
  const bounded = runtimeTestScope({ check, args: Array.from({ length: 30 }, () => "x".repeat(1000)),
    changedPaths: Array.from({ length: 50 }, (_, i) => `src/${i}.test.ts`) })!;
  assert.equal(bounded.argumentsTruncated, true);
  assert.equal(bounded.forwardedArgs.length, 12);
  assert.equal(bounded.omittedTests, 38);
  assert.ok(JSON.stringify(bounded).length < 9_000);
});
