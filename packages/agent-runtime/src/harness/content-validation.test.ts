import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { parseCode } from "./code-intelligence.js";
import { validateContent } from "./content-validation.js";
import { LightWorkspace } from "./test-client/light-workspace.js";

const execute = promisify(execFile);
const ordinaryFunction = "int value(void) { return 1; }\n";
const macroFunction = [
  '#include "regions.h"',
  "int value(void) {",
  "  BEGIN_REGION",
  "  return 7;",
  "  END_REGION",
  "}",
  "",
].join("\n");
const regionDefinitions = "#define BEGIN_REGION {\n#define END_REGION }\n";

const validSyntaxSamples = {
  "value.py": ["", "def value():\n    pass\n", "text = ''\n", "class Empty:\n    pass\n"],
  "value.rs": ["", "fn main() {}", "fn value() -> i32 { 1 }"],
  "value.go": ["", "package main\nfunc main() {}\n"],
  "Value.java": ["class Value {}", "class Value { void run() {} }"],
  "Value.cs": ["class Value {}", "class Value { void Run() {} }"],
  "value.js": ["", "function value() { return 1 }", "const value = () => ({})", "const text = ``"],
  "value.ts": ["", "interface Value {}", "type Value = {};", "function value() {}"],
  "value.sh": ["", "echo value", "cat <<'END'\nEND\n"],
};

for (const [path, samples] of Object.entries(validSyntaxSamples)) {
  test(`valid ${path} handles empty constructs and implicit delimiters`, async () => {
    for (const content of samples) {
      assert.equal(parseCode(path, Buffer.from(content)).errorCount, 0, content);
      const result = await validateContent({ path, content: Buffer.from(content), workspaceRoot: tmpdir() });
      assert.notEqual(result.status, "failed", JSON.stringify(result));
    }
  });
}

test("missing Python punctuation reports its location and expected token", async () => {
  const content = Buffer.from("def value(:\n    return 2\n");
  const result = await validateContent({ path: "value.py", content, workspaceRoot: tmpdir() });
  assert.equal(result.status, "failed");
  assert.match(result.diagnostics.join("\n"), /1:11 Expected "\)"/u);
  await assert.rejects(execute("python3", ["-c", "import ast; ast.parse('def value(:\\n    return 2\\n')"]));
});

test("missing punctuation preserves source during an atomic replacement", async () => {
  await fixture(async (root, workspace) => {
    const source = "def value():\n    return 1\n";
    await writeFile(join(root, "value.py"), source);
    await workspace.readCode({ target: "value.py" }, {});
    const patch = "*** Begin Patch\n*** Delete File: value.py\n*** Add File: value.py\n+def value(:\n+    return 2\n+\n*** End Patch";
    const result = await workspace.editCode({ operations: [{ kind: "patch", patch }] });
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(await readFile(join(root, "value.py"), "utf8"), source);
    assert.match(JSON.stringify(result), /1:11/u);
  });
});

for (const extension of ["c", "h", "cpp", "cc", "cxx", "hpp"]) {
  test(`unpreprocessed ${extension} remains unverified even without parser errors`, async () => {
    const result = await validateContent({
      content: Buffer.from(ordinaryFunction),
      path: `value.${extension}`,
      workspaceRoot: tmpdir(),
    });
    assert.equal(result.status, "unsupported");
    assert.match(result.diagnostics.join("\n"), /project compiler/u);
  });
}

for (const [extension, compiler] of [
  ["c", "cc"],
  ["cpp", "c++"],
]) {
  test(`valid macro-based ${extension} patches commit without claiming syntax validation`, async (t) => {
    await fixture(async (root, workspace) => {
      const path = `value.${extension}`;
      assert.ok(parseCode(path, Buffer.from(macroFunction)).errorCount > 0);
      const result = await workspace.editCode({
        operations: [{ kind: "patch", path, patch: macroFunction }],
      });
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.equal(
        (result.data as { parse: { status: string } }).parse.status,
        "unsupported",
      );
      assert.equal(await readFile(join(root, path), "utf8"), macroFunction);
      if (await compilerInstalled(t, compiler!))
        await execute(compiler!, ["-fsyntax-only", path], { cwd: root });
    });
  });
}

test("a C symbol replacement preserves valid macro content", async (t) => {
  await fixture(async (root, workspace) => {
    await writeFile(join(root, "value.c"), ordinaryFunction);
    await workspace.readCode({ target: "value.c#value" }, {});
    const result = await workspace.editCode({
      operations: [
        {
          kind: "symbol",
          target: "value.c#value",
          action: "replace",
          content: macroFunction,
        },
      ],
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
    if (await compilerInstalled(t, "cc"))
      await execute("cc", ["-fsyntax-only", "value.c"], { cwd: root });
  });
});

test("invalid C remains unverified and the compiler reports the real failure", async (t) => {
  await fixture(async (root, workspace) => {
    const result = await workspace.editCode({
      operations: [
        {
          kind: "patch",
          path: "invalid.c",
          patch: "int value(void) { return ; + }\n",
        },
      ],
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      (result.data as { parse: { status: string } }).parse.status,
      "unsupported",
    );
    if (await compilerInstalled(t, "cc"))
      await assert.rejects(
        execute("cc", ["-fsyntax-only", "invalid.c"], { cwd: root }),
      );
  });
});

test("a definite TypeScript syntax failure preserves atomicity beside an unverified C edit", async () => {
  await fixture(async (root, workspace) => {
    const result = await workspace.editCode({
      operations: [
        { kind: "patch", path: "value.c", patch: macroFunction },
        {
          kind: "patch",
          path: "invalid.ts",
          patch: "export const value = ;\n",
        },
      ],
    });
    assert.equal(result.status, "blocked", JSON.stringify(result));
    await assert.rejects(readFile(join(root, "value.c")), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "invalid.ts")), {
      code: "ENOENT",
    });
  });
});

/**
 * Whether `compiler` is installed. Without it, the test reports its final
 * compiler check as skipped: a missing executable must neither fail the
 * test nor pass as the compiler's rejection.
 */
async function compilerInstalled(t: TestContext, compiler: string) {
  const installed = await execute(compiler, ["--version"]).then(() => true, () => false);
  if (!installed) t.skip(`${compiler} is not installed: the compiler's own verdict was not checked`);
  return installed;
}

async function fixture(
  run: (root: string, workspace: LightWorkspace) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "blame-content-validation-"));
  try {
    await writeFile(join(root, "regions.h"), regionDefinitions);
    await run(
      root,
      new LightWorkspace(root, { sessionId: "content-validation" }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const path of ["Component.vue", "Component.svelte"]) {
  test(`${path} diagnostics use absolute source columns with Unicode prefixes`, async () => {
    for (const prefix of ['<script lang="ts">', 'é🧠<script lang="ts">', '\n<script lang="ts">']) {
      const source = `${prefix}const broken = ;</script>\n`;
      const result = await validateContent({ path, content: Buffer.from(source), workspaceRoot: tmpdir() });
      const beforeError = source.slice(0, source.indexOf("= ;"));
      const position = `${beforeError.split("\n").length}:${beforeError.length - beforeError.lastIndexOf("\n")}`;
      assert.equal(result.status, "failed");
      assert.ok(result.diagnostics.some((line) => line.startsWith(`${position} `)), JSON.stringify(result));
    }
  });
}
