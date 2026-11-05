import assert from "node:assert/strict";
import { delimiter } from "node:path";
import test from "node:test";
import { data, fixture } from "./light-agent-guidance-fixture.js";
import { lightSemanticHarnessTools } from "./light-tools.js";
import { readOnlyInspection, shellInspectionRoutes, type ShellInspectionRoute } from "./shell-inspection.js";
import { withBundledTools } from "./workspace-command-environment.js";

const root = "/work/project";

function routes(command: string, cwd?: string) {
  return shellInspectionRoutes(command, { root, ...(cwd ? { cwd } : {}) });
}

function search(command: string) {
  const [route] = routes(command) ?? [];
  assert.equal(route?.tool, "search_code", command);
  const { excludeLine, ...request } = (route as Extract<ShellInspectionRoute, { tool: "search_code" }>).request;
  return { excludeLine, request };
}

function read(command: string) {
  const [route] = routes(command) ?? [];
  assert.equal(route?.tool, "read_code", command);
  const { input, tailLines } = route as Extract<ShellInspectionRoute, { tool: "read_code" }>;
  return { input, tailLines };
}

test("grep and rg invocations become regex searches with grep's case and scope", () => {
  assert.deepEqual(search('grep -rliE "lineRange|selectedLines" packages/app/src').request, {
    query: "lineRange|selectedLines", mode: "regex", scope: ["packages/app/src"], caseSensitive: false, limit: 100, output: "files",
  });
  assert.deepEqual(search('cd packages/app && grep -rnE "codeSelection|CodeSelection" src --include=*.ts --include=*.tsx | head -20').request, {
    query: "codeSelection|CodeSelection", mode: "regex", caseSensitive: true, limit: 20,
    scope: ["packages/app/src/**/*.ts", "packages/app/src/**/*.tsx"],
  });
  assert.deepEqual(search('grep -n -B2 -A14 -E "^const (codeSelection)\\b" api/validators/user_story.ts | head -60').request, {
    query: "^const (codeSelection)\\b", mode: "regex", scope: ["api/validators/user_story.ts"], caseSensitive: true, limit: 60,
    contextBefore: 2, contextAfter: 14,
  });
  assert.deepEqual(search('rg -l -i "needle" packages/app/src -t ts').request, {
    query: "needle", mode: "regex", caseSensitive: false, limit: 100, output: "files",
    scope: ["packages/app/src/**/*.ts", "packages/app/src/**/*.tsx", "packages/app/src/**/*.mts", "packages/app/src/**/*.cts"],
  });
});

test("basic grep patterns keep their operators and literals", () => {
  assert.equal(search('grep -rn "first\\|second" src').request.query, "first|second");
  assert.equal(search('grep -rn "call(x)+" src').request.query, "call\\(x\\)\\+");
  assert.equal(search('grep -rnF "a.b(c" src').request.query, "a\\.b\\(c");
  assert.equal(search('grep -rnw "item" src').request.query, "\\b(?:item)\\b");
  assert.equal(search("grep -rn '[)]x' src").request.query, "[)]x");
});

test("a grep -v filter drops grep-style output lines", () => {
  const { excludeLine, request } = search('grep -rn "needle" src | grep -v test | head -40');
  assert.equal(request.limit, 40);
  assert.equal(excludeLine?.("src/a.test.ts:3:needle"), true);
  assert.equal(excludeLine?.("src/a.ts:3:needle"), false);
});

test("file reads map to read_code ranges", () => {
  assert.deepEqual(read("sed -n 1,60p packages/app/src/a.ts").input, { target: "packages/app/src/a.ts", range: { startLine: 1, endLine: 60 } });
  assert.deepEqual(read("head -40 src/a.ts").input, { target: "src/a.ts", range: { startLine: 1, endLine: 40 } });
  assert.deepEqual(read("cat src/a.ts | head -80").input, { target: "src/a.ts", range: { startLine: 1, endLine: 80 } });
  assert.deepEqual(read("cat src/a.ts").input, { target: "src/a.ts", view: "raw" });
  assert.equal(read("tail -n 25 src/a.ts").tailLines, 25);
  assert.deepEqual(read(`sed -n 3p ${root}/src/a.ts`, ).input, { target: "src/a.ts", range: { startLine: 3, endLine: 3 } });
});

test("ls of a directory becomes a directory read", () => {
  const [route] = routes("ls packages/api") ?? [];
  assert.deepEqual(route, { command: "ls packages/api", tool: "read_code", input: { target: "packages/api" }, listing: true });
  assert.equal(routes("ls -la packages/api"), undefined);
});

test("a chain of inspections becomes one route per statement", () => {
  const chain = routes('sed -n 1,10p a.ts; grep -n "x" a.ts | head -5 2>/dev/null');
  assert.deepEqual(chain?.map((route) => route.tool), ["read_code", "search_code"]);
});

test("commands the tools cannot reproduce keep running in the shell", () => {
  for (const command of [
    'grep -rn "x" node_modules/@pierre/diffs',
    'grep -v "x" a.ts',
    'grep "x"',
    "ls -a src",
    'grep -rn "$NAME" src',
    'grep -rn "x" src | sort',
    'grep -rn "x" src || true',
    "cat a.ts b.ts",
    'grep -rn "x" ../outside',
    'grep -rn "(?=x)" src -P',
    "npm test",
    'grep -rn "x" src > found.txt',
  ])
    assert.equal(routes(command), undefined, command);
});

test("read-only inspection commands are recognised without writes", () => {
  for (const command of ['grep -rn "x" src | head', "grep -c x a.ts 2>/dev/null", 'cd src && rg -l "x"'])
    assert.equal(readOnlyInspection(command), "search", command);
  for (const command of ["ls -a; cat README.md", 'find . -name "*.ts"', "wc -l a.ts", "test -f flag"])
    assert.equal(readOnlyInspection(command), "read", command);
  for (const command of ["sed -i s/a/b/ a.ts", "find . -name x -delete", "grep x a.ts > out.txt", "npm test", "cat a > b", "node script.js"])
    assert.equal(readOnlyInspection(command), undefined, command);
});

test("run_task answers a routed grep with search_code results and journals no check", async () => {
  await fixture({ "src/view.ts": "export function view() {\n  return selectLines();\n}\n" }, async (workspace) => {
    const result = data(await workspace.runTask({ kind: "command", command: 'grep -rn "selectLines" src' }, {} as never));
    assert.equal(result.servedBy, "search_code");
    const [match] = result.results as Array<Record<string, unknown>>;
    assert.equal(match?.qualifiedName, "view");
    assert.equal(match?.matchLine, 2);
    assert.match(String(result.guidance), /search_code/u);
    const range = data(await workspace.runTask({ kind: "command", command: "sed -n 2,3p src/view.ts" }, {} as never));
    assert.equal(range.servedBy, "read_code");
    assert.equal(range.content, "  return selectLines();\n}\n");
    assert.deepEqual(range.lines, [2, 3]);
    assert.equal(data(await workspace.readCode({ target: "@checks" }, {})).total, 0);
  });
});

test("an unrouted read-only command that matched nothing is not a failure", async () => {
  await fixture({ "notes.txt": "alpha\n" }, async (workspace) => {
    const result = await workspace.runTask({ kind: "command", command: "grep -c missing notes.txt | sort" }, {} as never);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal((result as { data: { exitCode: number } }).data.exitCode, 1);
    assert.equal((result as { data: { noMatch: boolean } }).data.noMatch, true);
    assert.equal(data(await workspace.readCode({ target: "@checks" }, {})).total, 0);
  });
});

test("a read-only pipeline cut short by head is not a failure", async () => {
  await fixture({ "big.txt": "alpha\n".repeat(200_000) }, async (workspace) => {
    const result = await workspace.runTask({ kind: "command", command: "echo start; cat big.txt | head -2" }, {} as never);
    assert.equal(result.status, "ok", JSON.stringify(result));
    const value = (result as { data: { exitCode: number; output: string; pipeClosedEarly: boolean } }).data;
    assert.equal(value.exitCode, 141);
    assert.equal(value.output, "start\nalpha\nalpha");
    assert.equal(value.pipeClosedEarly, true);
  });
});

test("run_task treats a command sent with kind inspect as a command", async () => {
  await fixture({ "notes.txt": "alpha\n" }, async (_workspace, directory) => {
    const tool = lightSemanticHarnessTools(directory).find((candidate) => candidate.name === "run_task")!;
    const result = await tool.execute({ kind: "inspect", command: "sed -n 1p notes.txt" }, { agentId: "lead", iteration: 1 } as never);
    assert.match(JSON.stringify(result), /alpha/u);
    assert.doesNotMatch(JSON.stringify(result), /Unrecognized key/u);
  });
});

test("workspace commands find the bundled ripgrep after installed tools", () => {
  const environment = withBundledTools({ PATH: ["/usr/bin", "/bin"].join(delimiter) }, "/bundle/ripgrep");
  assert.equal(environment.PATH, ["/usr/bin", "/bin", "/bundle/ripgrep"].join(delimiter));
  assert.equal(withBundledTools(environment, "/bundle/ripgrep"), environment);
});
