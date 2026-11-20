import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightWorkspace } from "./test-client/light-workspace.js";

const decoys = Array.from({ length: 12 }, (_, index) =>
  `export function needleVariant${index}() { return ${index}; }`).join("\n");
const target = "export function needle(n: number) { return n + 1; }\n";
async function fixture(run: (workspace: LightWorkspace, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "blame-declaration-search-"));
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "a.ts"), decoys + "\n");
    await writeFile(join(root, "z.ts"), target);
    await run(new LightWorkspace(root, { sessionId: "declaration-search" }), root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function results(workspace: LightWorkspace, query: string, mode: "symbol" | "auto" = "symbol", scope?: string) {
  const result = await workspace.searchCode({ query, mode, ...(scope ? { scope } : {}) });
  assert.equal(result.status, "ok", JSON.stringify(result));
  return (result as { data: { results: Array<{ alias: string; path: string; qualifiedName: string }>; limited?: boolean } }).data;
}

test("a saturated file keeps broad searches bounded; an explicit scope finds the later declaration", async () => {
  await fixture(async (workspace) => {
    const search = await results(workspace, "needle");
    assert.equal(search.results.length, 8);
    assert.equal(search.limited, true);
    assert.deepEqual(search.results.map(r => r.qualifiedName),
      Array.from({ length: 8 }, (_, i) => `needleVariant${i}`));
    const scoped = await results(workspace, "needle", "symbol", "z.ts");
    assert.equal(scoped.results[0]?.qualifiedName, "needle");
    assert.equal(scoped.results[0]?.path, "z.ts");
  });
});
for (const mode of ["symbol", "auto"] as const)
  test(`${mode} ranks the exact declaration before partial matches in one file`, async () => {
    await fixture(async (workspace, root) => {
      await writeFile(join(root, "a.ts"), decoys + "\n" + target);
      const search = await results(workspace, "needle", mode, "a.ts");
      assert.equal(search.results[0]?.qualifiedName, "needle");
      assert.ok(search.results.length <= 8);
    });
  });

test("no exact declaration retains stable substring search and its limit", async () => {
  await fixture(async (workspace) => {
    const search = await results(workspace, "needleVariant");
    assert.deepEqual(search.results.map(r => r.qualifiedName),
      Array.from({ length: 8 }, (_, i) => `needleVariant${i}`));
    assert.equal(search.limited, true);
  });
});

test("homonymous exact declarations remain visible rather than becoming one identity", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(join(root, "a.ts"), decoys.split("\n").slice(0, 5).join("\n"));
    await writeFile(join(root, "b.ts"), "export function Needle() { return 9; }\n");
    const search = await results(workspace, "needle");
    assert.deepEqual(search.results.slice(0, 2).map(r => r.qualifiedName), ["Needle", "needle"]);
    assert.deepEqual(search.results.slice(0, 2).map(r => r.path), ["b.ts", "z.ts"]);
  });
});

test("qualified declaration names take priority without erasing partial fallback", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(join(root, "a.ts"), "export class Box { " +
      Array.from({ length: 12 }, (_, i) => `paintVariant${i}() { return ${i}; }`).join("\n") +
      " paint() { return 99; } }\n");
    const search = await results(workspace, "Box.paint");
    assert.equal(search.results[0]?.qualifiedName, "Box.paint");
    assert.equal(search.results.length, 8);
  });
});

test("precise discovery does not authorize an unread edit or a stale body", async () => {
  await fixture(async (workspace, root) => {
    const search = await results(workspace, "needle", "symbol", "z.ts");
    const alias = search.results[0]!.alias;
    const edit = () => workspace.editCode({ operations: [{ kind: "symbol", target: alias,
      action: "replace_body", content: "{ return n + 2; }" }] });
    assert.notEqual((await edit()).status, "ok");
    assert.equal(await readFile(join(root, "z.ts"), "utf8"), target);
    assert.equal((await workspace.readCode({ target: alias, view: "symbol" }, {})).status, "ok");
    const external = target.replace("n + 1", "n + 99");
    await writeFile(join(root, "z.ts"), external);
    assert.notEqual((await edit()).status, "ok");
    assert.equal(await readFile(join(root, "z.ts"), "utf8"), external);
  });
});
