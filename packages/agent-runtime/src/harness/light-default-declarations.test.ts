import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { data, fixture } from "./light-agent-guidance-fixture.js";
import { declarationQuery } from "./light-reference-candidates.js";

const source = "export function needle(n: number) { return n + 1; }\n";
const files = Object.fromEntries([
  ...Array.from({ length: 12 }, (_, i) => [`a${String(i).padStart(2, "0")}.ts`,
    `export const caller${i} = () => needle(${i});\n`]),
  ["z.ts", source], ["other.ts", "export function needle(n: string) { return n; }\n"],
]);

for (const mode of [undefined, "auto", "text"] as const)
  test(`${mode ?? "default"} offers exact declarations beyond saturated call sites`, async () => {
    await fixture(files, async (workspace, root) => {
      const search = data(await workspace.searchCode({ query: "needle", ...(mode ? { mode } : {}) }));
      assert.equal(search.limited, true);
      assert.equal(search.declarationDiscovery.navigationOnly, true);
      assert.deepEqual(search.declarationCandidates.map((c: { path: string }) => c.path).sort(), ["other.ts", "z.ts"]);
      const index = search.declarationCandidates.findIndex((c: { path: string }) => c.path === "z.ts");
      const target = search.nextReads[index];
      assert.equal(target.target, "z.ts#needle");
      const edit = () => workspace.editCode({ operations: [{ kind: "symbol", target: target.target,
        action: "replace_body", content: "return n + 2;" }] });
      assert.notEqual((await edit()).status, "ok", "Search grants no edit coverage");
      assert.equal(data(await workspace.readCode(target, {})).qualifiedName, "needle");
      await writeFile(join(root, "z.ts"), source.replace("+ 1", "+ 99"));
      assert.notEqual((await edit()).status, "ok", "A read does not authorize a stale body");
      assert.match(await readFile(join(root, "z.ts"), "utf8"), /99/u);
    });
  });

test("declaration-prefix queries get a read route without interpreting arbitrary source as an identity", async () => {
  await fixture(files, async workspace => {
    const search = data(await workspace.searchCode({ query: "export function needle", mode: "symbol", scope: "z.ts" }));
    assert.equal(search.declarationCandidates[0].target, "z.ts#needle");
    for (const query of ["needle(x)", "needle|other", "function.*needle", "const needle =", "needle other"])
      assert.equal(declarationQuery(query), undefined);
    const literal = data(await workspace.searchCode({ query: "needle(x)", mode: "text" }));
    assert.equal(literal.declarationCandidates, undefined);
  });
});

test("declaration discovery respects scope and bounds and labels an incomplete scan", async () => {
  const many = Object.fromEntries(Array.from({ length: 66 }, (_, i) => [`a${String(i).padStart(2, "0")}.ts`, "// needle\n"]));
  await fixture({ ...many, "z.ts": source }, async workspace => {
    const broad = data(await workspace.searchCode({ query: "needle", mode: "text" }));
    assert.deepEqual(broad.declarationCandidates, []);
    assert.equal(broad.declarationDiscovery.visitedFiles, 64);
    assert.equal(broad.declarationDiscovery.limited, true);
    const scoped = data(await workspace.searchCode({ query: "needle", mode: "text", scope: "z.ts" }));
    assert.equal(scoped.declarationCandidates.length, 1);
    assert.equal(scoped.declarationDiscovery.eligibleFiles, 1);
  });
});
