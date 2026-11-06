import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { blockedCommandReason } from "./command-policy.js";
import { LightWorkspace } from "./light-workspace.js";
import { SessionJournal } from "./session-journal.js";
import { WorkspaceFiles } from "./workspace-files.js";
import { validationOutput } from "./validation-output.js";
import { parseCode } from "./code-intelligence.js";
import { editTargetSymbols } from "./light-navigation.js";
import { projectProviderContext } from "../context-projection.js";
import type { Message } from "@cline/sdk";
import type { LightEditCodeInput, LightReadCodeInput } from "./light-contracts.js";

const execute = promisify(execFile);
const duplicated =
  "def first():\n    return 1\n\ndef second():\n    return 1\n";

const classSources = {
  "counter.py":
    "class Counter:\n    def first(self):\n        return 1\n\n    def second(self):\n        return 2\n\n    def third(self):\n        return 3\n",
  "counter.ts":
    "class Counter {\n first() { return 1; }\n second() { return 2; }\n third() { return 3; }\n}\n",
  "Counter.java":
    "class Counter {\n int first() { return 1; }\n int second() { return 2; }\n int third() { return 3; }\n}\n",
  "Counter.cs":
    "class Counter {\n int first() { return 1; }\n int second() { return 2; }\n int third() { return 3; }\n}\n",
};

for (const view of [undefined, "auto", "raw", "range"] as const) {
  test(`requested line ranges are honored with ${view ?? "omitted"} view`, async () => {
    await fixture(
      { "lines.txt": "first\nsecond\nthird\n" },
      async (_root, workspace) => {
        const result = await workspace.readCode(
          {
            target: "lines.txt",
            view,
            range: { startLine: 2, endLine: 2 },
          },
          {},
        );
        assert.equal(result.status, "ok");
        const data = result.data as { content: string; view: string };
        assert.equal(data.view, "range");
        assert.equal(data.content, "second\n");
      },
    );
  });
}

test("repeated raw and range reads return the requested source", async () => {
  await fixture(
    { "lines.txt": "first\nsecond\nthird\n" },
    async (_root, workspace) => {
      await workspace.readCode({ target: "lines.txt" }, {});
      for (const input of [
        { target: "lines.txt", view: "raw" as const },
        {
          target: "lines.txt",
          view: "range" as const,
          range: { startLine: 2, endLine: 2 },
        },
      ]) {
        const result = await workspace.readCode(input, {});
        assert.equal(result.status, "ok");
        assert.equal(
          (result.data as { content: string }).content,
          input.range ? "second\n" : "first\nsecond\nthird\n",
        );
      }
    },
  );
});

test("symbol rereads return a complete body after a whole-file read", async () => {
  await fixture(
    { "counter.py": classSources["counter.py"] },
    async (_root, workspace) => {
      await workspace.readCode({ target: "counter.py" }, {});
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await workspace.readCode(
          { target: "counter.py#Counter.second" },
          {},
        );
        assert.equal(result.status, "ok");
        const data = result.data as { body: string; signature: string };
        assert.match(data.body, /return 2/u);
        assert.match(data.signature, /def second/u);
      }
    },
  );
});

for (const view of [undefined, "auto", "raw", "range"] as const) {
  test(`qualified symbol line ranges honor ${view ?? "omitted"} view`, async () => {
    await fixture({ "counter.py": classSources["counter.py"] }, async (_root, workspace) => {
      await assertSymbolLineRange(workspace, "counter.py#Counter.second", view);
    });
  });

  test(`symbol aliases use absolute file lines with ${view ?? "omitted"} view`, async () => {
    await fixture({ "counter.py": classSources["counter.py"] }, async (_root, workspace) => {
      const search = await workspace.searchCode({ query: "Counter.second", mode: "symbol" });
      assert.equal(search.status, "ok");
      const { results } = search.data as { results: Array<{ alias: string }> };
      await assertSymbolLineRange(workspace, results[0]!.alias, view);
    });
  });
}

async function assertSymbolLineRange(
  workspace: LightWorkspace,
  target: string,
  view: LightReadCodeInput["view"],
) {
  const result = await workspace.readCode({ target, view, range: { startLine: 6, endLine: 6 } }, {});
  assert.equal(result.status, "ok");
  const data = result.data as { content: string; view: string; complete: boolean };
  assert.equal(data.view, "range");
  assert.equal(data.content, "        return 2\n");
  assert.equal(data.complete, false);
}

test("symbol line ranges record only the observed bytes", async () => {
  const source = classSources["counter.py"];
  await fixture({ "counter.py": source }, async (root, workspace) => {
    await assertSymbolLineRange(workspace, "counter.py#Counter.second", "range");
    const journal = new SessionJournal(root, "friction");
    await journal.hydrate();
    const start = Buffer.byteLength(source.slice(0, source.indexOf("        return 2")));
    assert.deepEqual(journal.currentCoverage().entries.map(({ intervals }) => intervals), [
      [[start, start + Buffer.byteLength("        return 2\n")]],
    ]);
  });
});

test("a symbol range view requires an explicit range", async () => {
  await fixture({ "counter.py": classSources["counter.py"] }, async (_root, workspace) => {
    const result = await workspace.readCode({ target: "counter.py#Counter.second", view: "range" }, {});
    assert.equal(result.status, "blocked");
    assert.match(result.message, /range is required/u);
  });
});

for (const view of [undefined, "auto", "raw", "range"] as const) {
  test(`text aliases honor explicit absolute lines with ${view ?? "omitted"} view`, async () => {
    await fixture({ "lines.txt": "first\nsecond\nthird\n" }, async (root, workspace) => {
      const alias = await searchedTextAlias(workspace);
      const result = await workspace.readCode({ target: alias, view, range: { startLine: 3, endLine: 3 } }, {});
      assert.equal(result.status, "ok");
      assert.equal((result.data as { content: string }).content, "third\n");
      const journal = new SessionJournal(root, "friction");
      await journal.hydrate();
      assert.deepEqual(journal.currentCoverage().entries.map(({ intervals }) => intervals), [[[13, 19]]]);
    });
  });
}

test("line ranges do not bypass stale text alias detection", async () => {
  await fixture({ "lines.txt": "first\nsecond\nthird\n" }, async (root, workspace) => {
    const alias = await searchedTextAlias(workspace);
    await writeFile(join(root, "lines.txt"), "first\nchanged\nthird\n");
    const result = await workspace.readCode({ target: alias, view: "range", range: { startLine: 3, endLine: 3 } }, {});
    assert.equal(result.status, "blocked");
    assert.match(result.message, /stale/u);
  });
});

async function searchedTextAlias(workspace: LightWorkspace) {
  const search = await workspace.searchCode({ query: "second", mode: "text" });
  assert.equal(search.status, "ok");
  const { results } = search.data as { results: Array<{ alias: string }> };
  assert.equal(results.length, 1);
  return results[0]!.alias;
}

test("provider projection retains the latest actual reread and preserves the transcript", async () => {
  const source = "export const evidence = 'requested source remains available';\n".repeat(20);
  await fixture({ "evidence.ts": source }, async (_root, workspace) => {
    const history = await rereadHistory(workspace);
    const original = JSON.stringify(history);
    const projected = projectReadHistory(history);
    assert.equal(JSON.stringify(history), original);
    assert.doesNotMatch(JSON.stringify(projected.messages.slice(0, 2)), /requested source remains available/u);
    assert.match(JSON.stringify(projected.messages.at(-1)), /requested source remains available/u);
    assert.ok(projected.metrics.projectedBytesSaved > 500);
    assert.deepEqual(projectReadHistory(projected.messages).messages, projected.messages);
  });
});

async function rereadHistory(workspace: LightWorkspace) {
  const history: Message[] = [];
  for (const id of ["first", "second"]) {
    const input = { target: "evidence.ts", view: "raw" as const };
    const result = await workspace.readCode(input, {});
    history.push({ role: "assistant", content: [{ type: "tool_use", id, name: "read_code", input }] });
    history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(result) }] });
  }
  return history;
}

function projectReadHistory(history: Message[]) {
  return projectProviderContext(history, { systemPrompt: "", tools: [] });
}

for (const [path, source] of Object.entries(classSources)) {
  test(`symbol outlines in ${path} remain scoped and available after reading the body`, async () => {
    await fixture(
      { [path]: `${source}\n${source.replaceAll("Counter", "Unrelated")}` },
      async (_root, workspace) => {
        const target = `${path}#Counter`;
        await workspace.readCode({ target }, {});
        const result = await workspace.readCode(
          { target, view: "outline" },
          {},
        );
        assert.equal(result.status, "ok");
        // Too small to fold: the outline of the class is the class itself.
        const data = JSON.stringify(result.data);
        assert.match(data, /second/u);
        assert.doesNotMatch(data, /Unrelated/u);
      },
    );
  });
}

for (const [path, source] of Object.entries(classSources)) {
  test(`partial class reads expose methods in ${path}`, () => {
    const symbols = parseCode(path, Buffer.from(source)).symbols;
    const first = symbols.find(({ name }) => name === "first")!;
    const second = symbols.find(({ name }) => name === "second")!;
    const targets = editTargetSymbols(symbols, [
      [first.range_utf8_bytes[0] + 1, second.range_utf8_bytes[1]],
    ]);
    assert.deepEqual(
      new Set(targets.map(({ name }) => name)),
      new Set(["first", "second"]),
    );
    const whole = editTargetSymbols(symbols, [[0, Buffer.byteLength(source)]]);
    assert.deepEqual(
      whole.map(({ name }) => name),
      ["Counter"],
    );
    const body = editTargetSymbols(symbols, [
      [first.range_utf8_bytes[1] - 2, first.range_utf8_bytes[1] - 1],
    ]);
    assert.deepEqual(
      body.map(({ name }) => name),
      ["first"],
    );
  });
}

test("disjoint read intervals select their methods without the containing class", () => {
  const source = classSources["counter.py"];
  const symbols = parseCode("counter.py", Buffer.from(source)).symbols;
  const methods = symbols.filter(({ name }) =>
    ["first", "third"].includes(name),
  );
  const targets = editTargetSymbols(
    symbols,
    methods.map(({ range_utf8_bytes }) => range_utf8_bytes),
  );
  assert.deepEqual(targets.map(({ name }) => name).sort(), ["first", "third"]);
});

test("a fully read function remains editable when it contains a nested function", () => {
  const source =
    "def outer():\n    def inner():\n        return 1\n    return inner()\n";
  const symbols = parseCode("nested.py", Buffer.from(source)).symbols;
  const targets = editTargetSymbols(symbols, [[0, Buffer.byteLength(source)]]);
  assert.deepEqual(
    targets.map(({ name }) => name),
    ["outer"],
  );
});

test("a ranged read supplies an alias that edits only the selected Python method", async () => {
  await fixture({ "counter.py": classSources["counter.py"] }, async (root, workspace) => {
    const targets = await rangedMethodTargets(workspace);
    assert.equal(targets.length, 2);
    const target = targets.find(({ qualifiedName }) => qualifiedName.endsWith("second"))!;
    const edited = await workspace.editCode({
      operations: [{ kind: "symbol", target: target.alias, action: "replace_body", content: "return 7" }],
    });
    assert.equal(edited.status, "ok", JSON.stringify(edited));
    assert.equal(await readFile(join(root, "counter.py"), "utf8"), classSources["counter.py"].replace("return 2", "return 7"));
  });
});

async function rangedMethodTargets(workspace: LightWorkspace) {
  const result = await workspace.readCode({
    target: "counter.py", view: "range", range: { startLine: 2, endLine: 6 },
  }, {});
  assert.equal(result.status, "ok", JSON.stringify(result));
  return (result.data as { editTargets: Array<{ alias: string; qualifiedName: string }> }).editTargets;
}

for (const indent of ["", "        "]) {
  test(`Python body replacement accepts ${indent ? "existing" : "relative"} indentation`, async () => {
    const body = ["value = 4", "return value + 3"].map((line) => indent + line).join("\n");
    await checkPythonBody(body, "7");
  });
}

test("Python body indentation preserves nested functions and multiline string values", async () => {
  const body = '\n        def value():\n            return """first\nraw text\n  last"""\n        return value()\n';
  await checkPythonBody(body, "first\nraw text\n  last");
});

test("a Python body read can be written back without changing its source", async () => {
  const source = classSources["counter.py"].replace("return 2", "value = 4\n        return value + 3");
  await fixture({ "counter.py": source }, async (root, workspace) => {
    const read = await workspace.readCode({ target: "counter.py#Counter.second", view: "symbol" }, {});
    assert.equal(read.status, "ok");
    const body = (read.data as { body: string }).body;
    await replacePythonBody(workspace, body);
    assert.equal(await readFile(join(root, "counter.py"), "utf8"), source);
  });
});

test("inline Python method bodies expand to a valid block", async () => {
  const source = classSources["counter.py"].replace("def second(self):\n        return 2", "def second(self): return 2");
  await checkPythonBody("value = 4\nreturn value + 3", "7", source);
});

test("Python body replacement preserves tabs and CRLF source conventions", async () => {
  const source = classSources["counter.py"].replaceAll("    ", "\t").replaceAll("\n", "\r\n");
  await fixture({ "counter.py": source }, async (root, workspace) => {
    await replacePythonBody(workspace, "value = 4\nreturn value + 3");
    const content = await readFile(join(root, "counter.py"), "utf8");
    assert.equal(content, source.replace("return 2", "value = 4\r\n\t\treturn value + 3"));
    const result = await execute("python3", ["-c", "from counter import Counter; print(Counter().second())"], { cwd: root });
    assert.equal(result.stdout.trim(), "7");
  });
});

test("Python class body replacement preserves nested method indentation", async () => {
  await fixture({ "counter.py": classSources["counter.py"] }, async (root, workspace) => {
    const content = "def second(self):\n    return 7";
    await workspace.readCode({ target: "counter.py#Counter" }, {});
    const edited = await workspace.editCode({ operations: [{ kind: "symbol", target: "counter.py#Counter", action: "replace_body", content }] });
    assert.equal(edited.status, "ok", JSON.stringify(edited));
    const result = await execute("python3", ["-c", "from counter import Counter; print(Counter().second())"], { cwd: root });
    assert.equal(result.stdout.trim(), "7");
  });
});

async function checkPythonBody(body: string, expected: string, source = classSources["counter.py"]) {
  await fixture({ "counter.py": source }, async (root, workspace) => {
    await replacePythonBody(workspace, body);
    const result = await execute("python3", ["-c", "from counter import Counter; print(Counter().second())"], { cwd: root });
    assert.equal(result.stdout.trimEnd(), expected);
    const content = await readFile(join(root, "counter.py"), "utf8");
    assert.ok(content.includes("def first(self):\n        return 1"));
    assert.ok(content.includes("def third(self):\n        return 3"));
  });
}

async function replacePythonBody(workspace: LightWorkspace, content: string) {
  await workspace.readCode({ target: "counter.py#Counter.second" }, {});
  const result = await workspace.editCode({ operations: [{ kind: "symbol", target: "counter.py#Counter.second", action: "replace_body", content }] });
  assert.equal(result.status, "ok", JSON.stringify(result));
}

test("an unavailable Python entry module receives a recoverable environment diagnostic", async () => {
  await fixture({}, async (_root, workspace) => {
    const result = await workspace.runTask(
      {
        kind: "command",
        command: "python3 -m blame_nonexistent_validation_tool",
      },
      {},
    );
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.equal(result.category, "environment");
    assert.match(result.recovery ?? "", /interpreter/u);
    assert.match(result.recovery ?? "", /rerun/u);
    assert.doesNotMatch(
      result.recovery ?? "",
      /Fix the reported project error|report this validation unavailable/u,
    );
  });
});

test("an arbitrary Python failure preserves its traceback without guessing project validation", async () => {
  await fixture(
    { "check_local.py": "import blame_nonexistent_local_import\n" },
    async (_root, workspace) => {
      const result = await workspace.runTask(
        { kind: "command", command: "python3 -m check_local" },
        {},
      );
      assert.equal(result.status, "blocked");
      if (result.status !== "blocked") return;
      assert.equal(result.category, "command");
      assert.match(result.message, /ModuleNotFoundError/u);
    },
  );
});

test("a closed inspection pipe preserves its nonzero exit and useful output", async () => {
  await fixture({}, async (_root, workspace) => {
    const result = await workspace.runTask({
      kind: "command", command: "seq 1 100000 | head -2",
    }, {});
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.equal(result.category, "command");
    assert.match(result.message, /code 141\.[\s\S]*1\n2/u);
    assert.doesNotMatch(result.recovery ?? "", /project error|validation unavailable/u);
  });
});

test("a missing inspection executable remains a recoverable environment failure", async () => {
  await fixture({}, async (_root, workspace) => {
    const result = await workspace.runTask({
      kind: "command", command: "blame_nonexistent_inspection_tool",
    }, {});
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.equal(result.category, "environment");
    assert.match(result.message, /code 127/u);
    assert.match(result.recovery ?? "", /recover the required tool/u);
    assert.doesNotMatch(result.recovery ?? "", /Do not retry|finish_task|validation unavailable/u);
  });
});

test("a recognized failing project test keeps its validation failure", async () => {
  const manifest = { scripts: { test: "node -e \"console.error('assertion failed'); process.exit(7)\"" } };
  await fixture({ "package.json": JSON.stringify(manifest) }, async (_root, workspace) => {
    for (const input of [
      { kind: "project" as const, task: "test" },
      { kind: "command" as const, command: manifest.scripts.test },
    ]) {
      const result = await workspace.runTask(input, {});
      assert.equal(result.status, "ok");
      assert.match(JSON.stringify(result), /assertion failed/u);
      assert.match(JSON.stringify(result), /reported project error/u);
      assert.match(JSON.stringify(result), /"outcome":"failed"/u);
    }
  });
});

test("absolute workspace paths work across search, symbol reads and patches", async () => {
  await fixture({ "src/module.py": duplicated }, async (root, workspace) => {
    const path = join(root, "src/module.py");
    const search = await workspace.searchCode({
      query: "first",
      scope: join(root, "src/*.py"),
    });
    assert.equal(search.status, "ok", JSON.stringify(search));
    assert.match(JSON.stringify(search), /src\/module.py/u);
    assert.equal(
      (await workspace.readCode({ target: `${path}#first` }, {})).status,
      "ok",
    );
    const result = await patch(
      workspace,
      path,
      "@@ def first():\n-    return 1\n+    return 7",
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      await readFile(path, "utf8"),
      duplicated.replace("return 1", "return 7"),
    );
  });
});

test("absolute paths retain escape, symlink and protected metadata checks", async () => {
  await fixture({ "module.py": duplicated }, async (root, workspace) => {
    const files = new WorkspaceFiles(root);
    assert.throws(
      () => files.normalizePath(`${root}-other/module.py`),
      /escapes/u,
    );
    assert.throws(
      () => files.normalizePath(join(root, "../outside")),
      /escapes/u,
    );
    assert.throws(
      () => files.resolveForWrite(join(root, ".git/config")),
      /protects/u,
    );
    await symlink(dirname(root), join(root, "escape"));
    await assert.rejects(
      files.resolveForWriteVerified(join(root, "escape/new.txt")),
      /outside/u,
    );
    assert.equal(
      (await workspace.readCode({ target: join(root, "escape") }, {})).status,
      "blocked",
    );
    assert.equal(
      (
        await workspace.searchCode({
          query: "first",
          scope: `${root}-other/**`,
        })
      ).status,
      "blocked",
    );
  });
});

test("finite filesystem operations journal outputs without interpreter workarounds", async () => {
  await fixture({}, async (root, workspace) => {
    const result = await workspace.runTask(
      {
        kind: "command",
        command:
          "mkdir -p artifacts && printf sample > artifacts/input.txt && cp artifacts/input.txt artifacts/output.txt && chmod 600 artifacts/output.txt && git --version",
      },
      {},
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.match(JSON.stringify(result), /artifacts\/output.txt/u);
    assert.equal(
      await readFile(join(root, "artifacts/output.txt"), "utf8"),
      "sample",
    );
    assert.match(JSON.stringify(result), /stale/u);
  });
});

test("cloning preserves actual repository identity", async () => {
  await fixture({ "origin/value.txt": "sample" }, async (root, workspace) => {
    const origin = join(root, "origin");
    await execute("git", ["init", origin]);
    await execute("git", ["-C", origin, "add", "value.txt"]);
    await execute("git", [
      "-C",
      origin,
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "fixture",
    ]);
    const result = await workspace.runTask(
      { kind: "command", command: "git clone --depth 1 origin checkout" },
      {},
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    const revision = await execute("git", [
      "-C",
      join(root, "checkout"),
      "rev-parse",
      "HEAD",
    ]);
    assert.match(revision.stdout, /^[0-9a-f]{40}\n$/u);
    assert.equal(
      await readFile(join(root, "checkout/value.txt"), "utf8"),
      "sample",
    );
  });
});

test("Git text is data while actual lifecycle mutations remain refused", () => {
  for (const command of [
    "git --version",
    "git version",
    "git -C . status",
    "printf 'git commit'",
    "python -c 'print(\"unlink\")'",
  ])
    assert.equal(blockedCommandReason(command), undefined, command);
  for (const command of [
    "git push",
    "git -C . reset --hard",
    "env MODE=test git add .",
    "rm -rf .",
    "sudo true",
    "sleep 100 &",
  ])
    assert.ok(blockedCommandReason(command), command);
});

test("qualified patch anchors select repeated bodies and reject stale anchors", async () => {
  await fixture({ "module.py": duplicated }, async (root, workspace) => {
    const result = await patch(
      workspace,
      "module.py",
      "@@ def second():\n-    return 1\n+    return 9",
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    const expected = duplicated.replace(
      "def second():\n    return 1",
      "def second():\n    return 9",
    );
    assert.equal(await readFile(join(root, "module.py"), "utf8"), expected);
    assert.equal(
      (
        await patch(
          workspace,
          "module.py",
          "@@ def missing():\n-    return 1\n+    return 4",
        )
      ).status,
      "blocked",
    );
    assert.equal(await readFile(join(root, "module.py"), "utf8"), expected);
  });
});

test("indented anchors are resolved exactly without fuzzy source matching", async () => {
  const source =
    "class Box:\n    def first(self):\n        return 1\n    def second(self):\n        return 1\n";
  await fixture({ "module.py": source }, async (root, workspace) => {
    const result = await patch(
      workspace,
      "module.py",
      "@@ def second(self):\n-        return 1\n+        return 5",
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      await readFile(join(root, "module.py"), "utf8"),
      source.replace(
        "def second(self):\n        return 1",
        "def second(self):\n        return 5",
      ),
    );
  });
});

test("unanchored ambiguity remains atomic across a multi-file batch", async () => {
  await fixture(
    { "module.py": duplicated, "note.txt": "before\n" },
    async (root, workspace) => {
      const result = await workspace.editCode({
        operations: [
          {
            kind: "patch",
            path: "note.txt",
            patch: envelope("note.txt", "@@\n-before\n+after"),
          },
          {
            kind: "patch",
            path: "module.py",
            patch: envelope("module.py", "@@\n-    return 1\n+    return 4"),
          },
        ],
      });
      assert.equal(result.status, "blocked");
      assert.match(JSON.stringify(result), /Candidate at line 2/u);
      assert.match(JSON.stringify(result), /Candidate at line 5/u);
      assert.match(JSON.stringify(result), /def first\(\)/u);
      assert.match(JSON.stringify(result), /def second\(\)/u);
      assert.match(JSON.stringify(result), /unique @@ anchor/u);
      assert.equal(await readFile(join(root, "note.txt"), "utf8"), "before\n");
      assert.equal(await readFile(join(root, "module.py"), "utf8"), duplicated);
    },
  );
});

test("ordered hunks and end-of-file anchors disambiguate repeated lines", async () => {
  await fixture(
    { "data.txt": "unique\nvalue\nseparator\nvalue\n" },
    async (root, workspace) => {
      const result = await patch(
        workspace,
        "data.txt",
        "@@\n unique\n-value\n+first\n@@\n-value\n+last\n*** End of File",
      );
      assert.equal(result.status, "ok", JSON.stringify(result));
      assert.equal(
        await readFile(join(root, "data.txt"), "utf8"),
        "unique\nfirst\nseparator\nlast\n",
      );
    },
  );
});

test("identical candidate neighborhoods expose an applicable unique anchor without another read", async () => {
  const body = "    shared_call()\n".repeat(20) + "    return 1\n";
  const source = `def first():\n${body}\ndef second():\n${body}`;
  await fixture({ "module.py": source }, async (root, workspace) => {
    const ambiguous = await patch(
      workspace,
      "module.py",
      "@@\n-    return 1\n+    return 2",
    );
    assert.equal(ambiguous.status, "blocked");
    assert.match(ambiguous.message, /@@ def first\(\):/u);
    assert.match(ambiguous.message, /@@ def second\(\):/u);
    const anchors = [...ambiguous.message.matchAll(/^@@ (.+)$/gmu)];
    const result = await patch(
      workspace,
      "module.py",
      `@@ ${anchors[1]![1]}\n-    return 1\n+    return 2`,
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      await readFile(join(root, "module.py"), "utf8"),
      source.slice(0, source.lastIndexOf("return 1")) + "return 2\n",
    );
  });
});

test("candidate anchors respect trimmed matching and cannot select a previous occurrence", async () => {
  const source = "repeated\n    repeated\nvalue\nshared\nvalue\n";
  await fixture({ "data.txt": source }, async (_root, workspace) => {
    const ambiguous = await patch(
      workspace,
      "data.txt",
      "@@\n-value\n+changed",
    );
    assert.equal(ambiguous.status, "blocked");
    assert.doesNotMatch(ambiguous.message, /@@ repeated/u);
    assert.match(ambiguous.message, /@@ shared/u);
    const result = await patch(
      workspace,
      "data.txt",
      "@@ shared\n-value\n+changed",
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
  });
});

test("an unprefixed empty hunk line cannot hang patch computation", async () => {
  await fixture({ "data.txt": "old\n" }, async (root) => {
    const module = new URL("./light-patch.js", import.meta.url).href;
    const invalid = envelope("data.txt", "@@\n\n-old\n+new");
    const args = [root, "data.txt", "old\n", invalid]
      .map((value) => JSON.stringify(value))
      .join(",");
    const script = `import { planLightPatch } from ${JSON.stringify(module)}; try { await planLightPatch(${args}); } catch (error) { console.log(error.message); }`;
    const result = await execute(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 3_000 },
    );
    assert.match(result.stdout, /Patch context does not match/u);
    assert.equal(await readFile(join(root, "data.txt"), "utf8"), "old\n");
  });
});

test("unprefixed blank context lines normalize without weakening exact matching", async () => {
  await fixture({ "data.txt": "old\n\nnext\n" }, async (root, workspace) => {
    const result = await patch(
      workspace,
      "data.txt",
      "@@\n-old\n+new\n\n next",
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      await readFile(join(root, "data.txt"), "utf8"),
      "new\n\nnext\n",
    );
  });
});

test("non-Node dependencies receive an actionable ecosystem diagnostic", async () => {
  await fixture(
    { "pyproject.toml": "[project]\nname = 'example'\n" },
    async (_root, workspace) => {
      const result = await workspace.runTask(
        { kind: "dependency", action: "add", packages: ["pytest"] },
        {},
      );
      assert.equal(result.status, "blocked");
      assert.match(JSON.stringify(result), /native package manager/u);
      assert.doesNotMatch(JSON.stringify(result), /ENOENT/u);
    },
  );
});

function envelope(path: string, body: string) {
  return `*** Begin Patch\n*** Update File: ${path}\n${body}\n*** End Patch`;
}

test("successful known validations expose concise output and a complete log without changing source", async () => {
  await fixture(validationFixture(), async (root, workspace) => {
    const files = new WorkspaceFiles(root);
    const before = (await files.snapshot()).revision.source_revision_id;
    const result = await workspace.runTask(
      { kind: "project", task: "test" },
      {},
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    const data = result.data as {
      output: string;
      outputLog: string;
      validation: { status: string };
    };
    assert.ok(data.output.length <= 900);
    assert.match(data.output, /BEGIN|END/u);
    assert.equal(data.validation.status, "unknown");
    assert.match(
      await readFile(join(root, data.outputLog), "utf8"),
      /detail_50/u,
    );
    const detail = await workspace.runTask(
      { kind: "command", command: `tail -2 ${data.outputLog}` },
      {},
    );
    assert.equal(detail.status, "ok");
    assert.match(JSON.stringify(detail), /END/u);
    assert.equal((await files.snapshot()).revision.source_revision_id, before);
  });
});

test("inspection output and failed validation diagnostics are not shortened by success projection", async () => {
  await fixture(validationFixture(), async (_root, workspace) => {
    // A plain cat is answered by read_code; a pipeline the router keeps runs in the shell.
    const routed = await workspace.runTask(
      { kind: "command", command: "cat inspection.txt" },
      {},
    );
    assert.equal(routed.status, "ok", JSON.stringify(routed));
    const read = routed.data as { content: string; servedBy: string };
    assert.equal(read.servedBy, "read_code");
    assert.ok(read.content.length > 1_200);
    const inspected = await workspace.runTask(
      { kind: "command", command: "cat inspection.txt | cat" },
      {},
    );
    assert.equal(inspected.status, "ok", JSON.stringify(inspected));
    const data = inspected.data as { output: string; outputLog?: string };
    assert.ok(data.output.length > 1_200);
    assert.equal(data.outputLog, undefined);
  });
  await fixture(
    validationFixture("process.exit(1)"),
    async (_root, workspace) => {
      const failed = await workspace.runTask(
        { kind: "project", task: "test" },
        {},
      );
      assert.equal(failed.status, "ok", JSON.stringify(failed));
      assert.match(JSON.stringify(failed), /detail_50/u);
      assert.match(JSON.stringify(failed), /outputLog/u);
    },
  );
});

test("source-changing validation cannot acquire a fresh proof or concise success output", async () => {
  await fixture(
    validationFixture(
      "require('node:fs').writeFileSync('source.txt', 'changed')",
    ),
    async (_root, workspace) => {
      const result = await workspace.runTask(
        { kind: "project", task: "test" },
        {},
      );
      assert.match(JSON.stringify(result), /"status":"stale"/u);
      assert.doesNotMatch(
        JSON.stringify(result),
        /"validation":\{"status":"passed"/u,
      );
    },
  );
});

test("validation logs reject symlink directories and retain the existing diagnostic fallback", async () => {
  await fixture({}, async (root) => {
    await mkdir(join(root, ".blame"));
    await symlink(dirname(root), join(root, ".blame/logs"));
    const result = await validationOutput(root, "x".repeat(5_000));
    assert.equal(result.outputLog, undefined);
    assert.ok(result.output.length > 1_200 && result.output.length <= 4_000);
  });
});

test("complete validation logs contain the same secret redaction as tool output", async () => {
  const synthetic = "ghp_" + "0123456789".repeat(3);
  await fixture(
    validationFixture(`console.log('${synthetic}')`),
    async (root, workspace) => {
      const result = await workspace.runTask(
        { kind: "project", task: "test" },
        {},
      );
      assert.equal(result.status, "ok", JSON.stringify(result));
      const data = result.data as { outputLog: string };
      const logged = await readFile(join(root, data.outputLog), "utf8");
      assert.ok(!logged.includes(synthetic));
      assert.match(logged, /REDACTED_SECRET:GITHUB_TOKEN/u);
    },
  );
});

function validationFixture(suffix = "") {
  return {
    "package.json": JSON.stringify({ scripts: { test: "node check.cjs" } }),
    "source.txt": "original",
    "inspection.txt": "actual inspection data\n".repeat(100),
    "check.cjs": `console.log('BEGIN'); for (let i = 0; i < 100; i++) console.log('detail_' + i + ' ' + 'x'.repeat(15)); console.log('END'); ${suffix}`,
  };
}

function patch(workspace: LightWorkspace, path: string, body: string) {
  return workspace.editCode({
    operations: [{ kind: "patch", path, patch: envelope(path, body) }],
  });
}

async function fixture(
  files: Record<string, string>,
  run: (root: string, workspace: LightWorkspace) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "blame-friction-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await run(root, new LightWorkspace(root, { sessionId: "friction" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const orderedSource =
  "def first():\n    return 1\n\ndef second():\n    return 1\n";
const orderedReplacement = "@@\n-    return 1\n+    return 2";

test("a complete ordered patch replaces every repeated occurrence uniquely", async () => {
  await orderedPatchFixture(orderedSource, async (workspace, root) => {
    const result = await applyOrderedPatch(
      workspace,
      `${orderedReplacement}\n${orderedReplacement}`,
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      await readFile(join(root, "sample.py"), "utf8"),
      orderedSource.replaceAll("return 1", "return 2"),
    );
  });
});

test("later context constrains the preceding change without a special anchor", async () => {
  await orderedPatchFixture(orderedSource, async (workspace, root) => {
    const body = `@@\n def first():\n${orderedReplacement}\n@@\n def second():`;
    const result = await applyOrderedPatch(workspace, body);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      await readFile(join(root, "sample.py"), "utf8"),
      orderedSource.replace("return 1", "return 2"),
    );
  });
});

test("multiple complete placements remain ambiguous and preserve the whole batch", async () => {
  const source = `${orderedSource}\ndef third():\n    return 1\n`;
  await orderedPatchFixture(source, async (workspace, root) => {
    const operation: LightEditCodeInput["operations"][number] = {
      kind: "patch",
      path: "other.txt",
      patch: "new",
    };
    const result = await applyOrderedPatch(
      workspace,
      `${orderedReplacement}\n${orderedReplacement}`,
      [operation],
    );
    assert.equal(result.status, "blocked");
    assert.match(result.message, /ambiguous/u);
    assert.equal(await readFile(join(root, "sample.py"), "utf8"), source);
    await assert.rejects(readFile(join(root, "other.txt")), {
      code: "ENOENT",
    });
  });
});

test("missing later context never leaves an earlier change applied", async () => {
  await orderedPatchFixture(orderedSource, async (workspace, root) => {
    const result = await applyOrderedPatch(
      workspace,
      `${orderedReplacement}\n@@\n def missing():`,
    );
    assert.equal(result.status, "blocked");
    assert.equal(
      await readFile(join(root, "sample.py"), "utf8"),
      orderedSource,
    );
  });
});

test("ordered patches retain Unicode and CRLF content", async () => {
  const source = orderedSource
    .replaceAll("1", '"été"')
    .replaceAll("\n", "\r\n");
  const change = '@@\n-    return "été"\n+    return "hiver"';
  await orderedPatchFixture(source, async (workspace, root) => {
    const result = await applyOrderedPatch(
      workspace,
      `${change}\n${change}`,
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      await readFile(join(root, "sample.py"), "utf8"),
      source.replaceAll("été", "hiver"),
    );
  });
});

test("overlapping multiline contexts are recognized as ambiguous", async () => {
  const source = "value = 1\n".repeat(3);
  await orderedPatchFixture(source, async (workspace, root) => {
    const result = await applyOrderedPatch(
      workspace,
      "@@\n-value = 1\n-value = 1\n+value = 2\n+value = 2",
    );
    assert.equal(result.status, "blocked");
    assert.match(result.message, /ambiguous/u);
    assert.equal(await readFile(join(root, "sample.py"), "utf8"), source);
  });
});

test("complete patch matching agrees with exhaustive ordered placements", async () => {
  for (let mask = 0; mask < 16; mask += 1) {
    const lines = Array.from({ length: 4 }, (_, index) =>
      mask & (1 << index) ? "a" : "b",
    );
    for (const targets of [
      ["a", "a"],
      ["a", "b"],
      ["b", "a"],
      ["b", "b"],
    ])
      await verifyOrderedPlacements(lines, targets);
  }
});

async function verifyOrderedPlacements(
  lines: string[],
  targets: string[],
) {
  const placements = orderedPlacements(lines, targets);
  const source = `${lines.join("\n")}\n`;
  await orderedPatchFixture(source, async (workspace, root) => {
    const body = targets
      .map((value, index) => `@@\n-${value}\n+changed_${index}`)
      .join("\n");
    const result = await applyOrderedPatch(workspace, body);
    assert.equal(
      result.status,
      placements.length === 1 ? "ok" : "blocked",
      `${source}: ${targets}`,
    );
    const expected = [...lines];
    if (placements.length === 1)
      placements[0]!.forEach(
        (position, index) => (expected[position] = `changed_${index}`),
      );
    assert.equal(
      await readFile(join(root, "sample.py"), "utf8"),
      `${expected.join("\n")}\n`,
    );
  });
}

function orderedPlacements(lines: string[], targets: string[]) {
  const placements: number[][] = [];
  for (let first = 0; first < lines.length; first += 1)
    for (let second = first + 1; second < lines.length; second += 1)
      if (lines[first] === targets[0] && lines[second] === targets[1])
        placements.push([first, second]);
  return placements;
}

function applyOrderedPatch(
  workspace: LightWorkspace,
  body: string,
  prefix: LightEditCodeInput["operations"] = [],
) {
  return workspace.editCode({
    operations: [
      ...prefix,
      {
        kind: "patch",
        path: "sample.py",
        patch: envelope("sample.py", body),
      },
    ],
  });
}

async function orderedPatchFixture(
  source: string,
  run: (workspace: LightWorkspace, root: string) => Promise<void>,
) {
  await fixture({ "sample.py": source }, (root, workspace) =>
    run(workspace, root),
  );
}

test("ordered ambiguity anchors resolve to their advertised candidate", async () => {
  const source = `${orderedSource}${"\ndef repeated():\n    return 1\n".repeat(3)}`;
  await orderedPatchFixture(source, async (workspace, root) => {
    const result = await applyOrderedPatch(workspace, `${orderedReplacement}\n${orderedReplacement}`);
    assert.equal(result.status, "blocked");
    const candidates = result.message.split("Candidate at line ").slice(1);
    const candidate = candidates[1]!;
    const line = Number(candidate.match(/^\d+/u)?.[0]);
    const anchor = candidate.match(/^@@ (.+)$/mu)?.[1];
    assert.ok(anchor, result.message);
    const retried = await applyOrderedPatch(workspace, `@@ ${anchor}\n-    return 1\n+    return 2`);
    assert.equal(retried.status, "ok", JSON.stringify(retried));
    const lines = source.split("\n");
    lines[line - 1] = "    return 2";
    assert.equal(await readFile(join(root, "sample.py"), "utf8"), lines.join("\n"));
  });
});

const symbolBoundaryFixtures = [
  { path: "signature.ts", target: "Reader.first", prefix: "interface Reader { previous(): void; ",
    declaration: "first(): PromiseLike<void>;", suffix: " sibling(): void; }\n",
    replacement: "changed(): PromiseLike<void>;" },
  { path: "comma-signature.ts", target: "Reader.first", prefix: "type Reader = { previous(): void, ",
    declaration: "first(): PromiseLike<void>,", suffix: " sibling(): void };\n",
    replacement: "changed(): PromiseLike<void>," },
  { path: "unterminated-signature.ts", target: "Reader.first", prefix: "// élève 🐱\r\ninterface Reader {\r\n  ",
    declaration: "first?(): PromiseLike<void>", suffix: "\r\n  sibling(): void\r\n}\r\n",
    replacement: "changed?(): PromiseLike<void>", newline: "\r\n" },
  { path: "simple.c", target: "first", prefix: "int previous(void) { return 0; }\n",
    declaration: "int first(void) { return 1; }", suffix: "\nint second(void) { return 2; }\n",
    replacement: "int changed(void) { return 7; }" },
  { path: "simple.cpp", target: "first", prefix: "int previous() { return 0; }\n",
    declaration: "int first() { return 1; }", suffix: "\nint second() { return 2; }\n",
    replacement: "int changed() { return 7; }" },
  { path: "simple.cs", target: "First", prefix: "class Before {}\n",
    declaration: "class First {}", suffix: "\nclass Second {}\n", replacement: "class Changed {}" },
  { path: "exports.ts", target: "first", prefix: "export const previous = 0;\n",
    declaration: "export function first() { return 1; }", suffix: "\nexport function second() { return 2; }\n",
    replacement: "export function changed() { return 7; }" },
  { path: "decorated.py", target: "first", prefix: "previous = 0\n\n",
    declaration: "@trace\ndef first():\n    return 1", suffix: "\n\ndef second():\n    return 2\n",
    replacement: "def changed():\n    return 7" },
  { path: "nested.cs", target: "Outer.First", prefix: "class Outer {\n  ",
    declaration: "class First {}", suffix: "\n  class Second {}\n}\nclass Other {}\n",
    replacement: "class Changed {}" },
  { path: "nested.cpp", target: "Outer.first", prefix: "class Outer {\n  ",
    declaration: "int first() { return 1; }", suffix: "\n  int second() { return 2; }\n};\nint other() { return 3; }\n",
    replacement: "int changed() { return 7; }" },
  { path: "template.cpp", target: "first", prefix: "int previous() { return 0; }\n",
    declaration: "template<class T> T first(T value) { return value; }", suffix: "\nint second() { return 2; }\n",
    replacement: "template<class T> T changed(T value) { return value; }" },
  { path: "unicode.c", target: "first", prefix: "const char *label = \"élève 🐱\";\r\n",
    declaration: "int first(void) { return 1; }", suffix: "\r\nint second(void) { return 2; }\r\n",
    replacement: "int changed(void) { return 7; }", newline: "\r\n" },
  { path: "conditional.c", target: "first", prefix: "#ifdef ENABLED\n",
    declaration: "int first(void) { return 1; }", suffix: "\nint second(void) { return 2; }\n#endif\nint other(void) { return 3; }\n",
    replacement: "int changed(void) { return 7; }" },
];

type SymbolBoundaryFixture = typeof symbolBoundaryFixtures[number];
type SymbolBoundaryAction = "delete" | "replace" | "insert_before" | "insert_after";

for (const sample of symbolBoundaryFixtures) {
  for (const action of ["delete", "replace", "insert_before", "insert_after"] as const) {
    test(`${action} keeps siblings and syntax wrappers in ${sample.path}`, async () => {
      await checkSymbolMutationBoundary(sample, action);
    });
  }
}

async function checkSymbolMutationBoundary(sample: SymbolBoundaryFixture, action: SymbolBoundaryAction) {
  const original = sample.prefix + sample.declaration + sample.suffix;
  const newline = sample.newline ?? "\n";
  const content = action === "insert_before" ? sample.replacement + newline :
    action === "insert_after" ? newline + sample.replacement : sample.replacement;
  await fixture({ [sample.path]: original }, async (root, workspace) => {
    await workspace.readCode({ target: `${sample.path}#${sample.target}` }, {});
    const result = await workspace.editCode({ operations: [{ kind: "symbol", target: `${sample.path}#${sample.target}`, action, content }] });
    assert.equal(result.status, "ok", JSON.stringify(result));
    const changed = action === "delete" ? "" : action === "replace" ? content :
      action === "insert_before" ? content + sample.declaration : sample.declaration + content;
    assert.equal(await readFile(join(root, sample.path), "utf8"), sample.prefix + changed + sample.suffix);
  });
}
