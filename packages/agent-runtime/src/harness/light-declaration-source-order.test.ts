import assert from "node:assert/strict";
import test from "node:test";
import { data, fixture } from "./light-agent-guidance-fixture.js";

async function withOrder<T>(enabled: boolean, run: () => Promise<T>) {
  const before = process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER;
  try { process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER = String(enabled); return await run(); }
  finally { if (before === undefined) delete process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER; else process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER = before; }
}

test("test-heavy callers do not exhaust declaration bytes before the source definition", async () => {
  const callers = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [
    `src/__tests__/a${i}.test.ts`,
    Array.from({ length: 40 }, (_, j) => `export interface Example${j} { value: string }`).join("\n") + `\n/* ${"x".repeat(125_000)} */\n`,
  ]));
  await fixture({ ...callers, "src/types.ts": "export interface MutateOptions { settled?: () => void }\n" }, async workspace => {
    const lookup = () => workspace.searchCode({ query: "interface MutateOptions", scope: "src" });
    const reference = data(await withOrder(false, lookup));
    const changed = data(await withOrder(true, lookup));
    assert.deepEqual(reference.declarationCandidates, []);
    assert.equal(changed.declarationCandidates[0].path, "src/types.ts");
    for (const result of [reference, changed]) {
      assert.equal(result.declarationDiscovery.limited, true);
      assert.equal(result.declarationDiscovery.navigationOnly, true);
      assert.ok(result.declarationDiscovery.readBytes <= 1024 * 1024);
      assert.ok(result.declarationDiscovery.visitedFiles <= 64);
    }
    assert.deepEqual(changed.declarationDiscovery.limits, reference.declarationDiscovery.limits);
    assert.deepEqual(changed.results.map((r: { path: string }) => r.path), reference.results.map((r: { path: string }) => r.path));
  });
});

test("file limits, explicit test scopes and exact test-filename affinity remain usable", async () => {
  const callers = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`src/__tests__/a${String(i).padStart(2, "0")}.spec.ts`, "// needle\n"]));
  await fixture({ ...callers, "src/api.ts": "export function needle() { return 1 }\n", "src/__tests__/testTarget.ts": "export function testTarget() { return 2 }\n" }, async workspace => {
    const broad = data(await withOrder(true, () => workspace.searchCode({ query: "needle", scope: "src", mode: "text" })));
    assert.equal(broad.declarationCandidates[0].path, "src/api.ts");
    assert.equal(broad.declarationDiscovery.visitedFiles, 64);
    assert.equal(broad.declarationDiscovery.limited, true);
    const scoped = data(await withOrder(true, () => workspace.searchCode({ query: "testTarget", scope: "src/__tests__", mode: "text" })));
    assert.equal(scoped.declarationCandidates[0].path, "src/__tests__/testTarget.ts");
    const targeted = data(await withOrder(true, () => workspace.searchCode({ query: "testTarget", scope: "src", mode: "text" })));
    assert.equal(targeted.declarationCandidates[0].path, "src/__tests__/testTarget.ts");
  });
});
