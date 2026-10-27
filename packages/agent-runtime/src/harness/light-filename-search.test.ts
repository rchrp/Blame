import assert from "node:assert/strict";
import test from "node:test";
import { pathMatches } from "./light-navigation.js";
import { data, fixture } from "./light-agent-guidance-fixture.js";

test("file-like queries do not turn test.ts into combineLatest.ts or tokenize filename fragments", () => {
  assert.deepEqual(pathMatches("test.ts", ["src/combineLatest.ts", "src/map.test.ts", "test.ts", "src/test.js"]), ["test.ts", "src/map.test.ts"]);
  assert.deepEqual(pathMatches("package.json", ["package-lock.json", "package.json", "docs/package-history.json", "app/package.json"]), ["package.json", "app/package.json"]);
  assert.deepEqual(pathMatches("./src/query.ts", ["src/query.ts", "other/src/query.ts", "src/query.test.ts"]), ["src/query.ts", "other/src/query.ts"]);
  assert.deepEqual(pathMatches(".test.ts", ["src/map.test.ts", "src/combineLatest.ts"]), ["src/map.test.ts"]);
});

test("word queries keep fuzzy paths, and literal text/symbol search still finds source content", async () => {
  assert.ok(pathMatches("query", ["src/queryClient.ts"]).length);
  await fixture({ "src/combineLatest.ts": "export const latest=1;\n", "src/lookups.ts": 'export const name="test.ts";\n' }, async workspace => {
    const found = data(await workspace.searchCode({ query: "test.ts", mode: "text" }));
    assert.ok(found.results.some((v: { path: string; kind: string }) => v.path === "src/lookups.ts" && v.kind === "text"));
    assert.ok(!found.results.some((v: { path: string; reason: string }) => v.path === "src/combineLatest.ts" && v.reason === "path_name"));
  });
});

test("the isolated reference flag restores old fuzzy filename behavior", () => {
  const previous = process.env.BLAME_AGENT_LITERAL_FILE_SEARCH;
  try {
    process.env.BLAME_AGENT_LITERAL_FILE_SEARCH = "false";
    assert.deepEqual(pathMatches("test.ts", ["src/combineLatest.ts"]), ["src/combineLatest.ts"]);
  } finally { if (previous === undefined) delete process.env.BLAME_AGENT_LITERAL_FILE_SEARCH; else process.env.BLAME_AGENT_LITERAL_FILE_SEARCH = previous; }
});
