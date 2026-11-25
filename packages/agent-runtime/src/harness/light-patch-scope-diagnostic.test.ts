import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LightToolResult } from "./light-contracts.js";
import { LightWorkspace } from "./test-client/light-workspace.js";
const patch = (body: string, path = "code.ts") => `*** Begin Patch\n*** Update File: ${path}\n@@\n${body}\n*** End Patch`;
const source = "/** existing description */\nexport function first() {\n  return 1;\n}\n" + "\n".repeat(40) + "export function second() {\n  return 20;\n}\n";
function recovery(result: LightToolResult<unknown>) {
  assert.equal(result.status, "blocked", JSON.stringify(result));
  const text = (result as { recovery: string }).recovery;
  return JSON.parse(text.slice(text.indexOf("{"))) as {
    patchCorrection?: { reason: string; affectedLines: [number, number][]; changesOutsideSymbol: boolean };
    nextRead: { target: string; view: "range"; range: { startLine: number; endLine: number } };
  };
}
async function fixture(run: (workspace: LightWorkspace, root: string, alias: string) => Promise<void>, text = source, observe = true) {
  const root = await mkdtemp(join(tmpdir(), "blame-scope-diagnostic-"));
  try {
    await writeFile(join(root, "code.ts"), text);
    const workspace = new LightWorkspace(root, { sessionId: "scope-diagnostic" });
    const result = observe ? await workspace.readCode({ target: "code.ts#first" }, {})
      : await workspace.searchCode({ query: "first", scope: "code.ts", mode: "symbol" });
    assert.equal(result.status, "ok", JSON.stringify(result));
    const data = (result as { data: { alias?: string; results?: { alias: string }[] } }).data;
    await run(workspace, root, data.alias ?? data.results![0]!.alias);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const edit = (workspace: LightWorkspace, alias: string, content: string) =>
  workspace.editCode({ operations: [{ kind: "patch", target: alias, patch: content }] });

test("a unique distant match names its scope conflict and reads the actual affected lines", async () => {
  await fixture(async (workspace, root, alias) => {
    const content = patch("-  return 20;\n+  return 21;");
    const result = await edit(workspace, alias, content), hint = recovery(result);
    assert.equal(hint.patchCorrection?.reason, "context_outside_symbol");
    assert.equal(hint.patchCorrection.changesOutsideSymbol, true);
    assert.deepEqual(hint.patchCorrection.affectedLines, [[46, 46]]);
    assert.ok(hint.nextRead.range.startLine <= 46 && hint.nextRead.range.endLine >= 46);
    assert.ok(hint.nextRead.range.endLine - hint.nextRead.range.startLine < 30);
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), source);
    await workspace.readCode(hint.nextRead, {});
    assert.equal((await workspace.editCode({ operations: [{ kind: "patch", patch: content }] })).status, "ok");
    assert.match(await readFile(join(root, "code.ts"), "utf8"), /return 21;/u);
  });
});
test("outside JSDoc context can be distinguished even when changed bytes remain inside the symbol", async () => {
  await fixture(async (workspace, root, alias) => {
    const content = patch(" /** existing description */\n export function first() {\n-  return 1;\n+  return 2;\n }");
    const hint = recovery(await edit(workspace, alias, content));
    assert.equal(hint.patchCorrection?.reason, "context_outside_symbol");
    assert.equal(hint.patchCorrection.changesOutsideSymbol, false);
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), source);
  });
});
test("mixed inside/outside hunks remain an atomic refusal", async () => {
  await fixture(async (workspace, root, alias) => {
    const content = patch("-  return 1;\n+  return 2;\n@@\n-  return 20;\n+  return 21;");
    const hint = recovery(await edit(workspace, alias, content));
    assert.equal(hint.patchCorrection?.reason, "context_outside_symbol");
    assert.equal(hint.patchCorrection.changesOutsideSymbol, true);
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), source);
  });
});
test("unmatched stale preimages do not claim a matching whole-file plan", async () => {
  await fixture(async (workspace, root, alias) => {
    const hint = recovery(await edit(workspace, alias, patch("-  return 999;\n+  return 2;")));
    assert.equal(hint.patchCorrection, undefined); assert.equal(await readFile(join(root, "code.ts"), "utf8"), source);
  });
});
test("globally ambiguous context stays ambiguous without an invented outside location", async () => {
  const text = source + "export function third() {\n  return 20;\n}\n";
  await fixture(async (workspace, root, alias) => {
    const hint = recovery(await edit(workspace, alias, patch("-  return 20;\n+  return 2;")));
    assert.equal(hint.patchCorrection, undefined); assert.equal(await readFile(join(root, "code.ts"), "utf8"), text);
  }, text);
});
test("scope hints grant no unseen body coverage", async () => {
  await fixture(async (workspace, root, alias) => {
    recovery(await edit(workspace, alias, patch("-  return 20;\n+  return 2;")));
    assert.equal((await workspace.editCode({ operations: [{ kind: "symbol", target: alias, action: "replace_body", content: "return 3;" }] })).status, "blocked");
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), source);
  }, source, false);
});
test("a scoped hunk may end on the declaration's closing line", async () => {
  await fixture(async (workspace, root, alias) => {
    const result = await edit(workspace, alias, patch("-  return 1;\n+  return 2;\n }"));
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.match(await readFile(join(root, "code.ts"), "utf8"), /return 2;\n\}\n/u);
  });
});
test("a scoped hunk may start on the declaration's indented first line", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-scope-indented-"));
  try {
    await writeFile(join(root, "box.ts"), "export class Box {\n  first() {\n    return 1;\n  }\n}\n");
    const workspace = new LightWorkspace(root, { sessionId: "scope-indented" });
    const read = await workspace.readCode({ target: "box.ts#Box.first" }, {});
    assert.equal(read.status, "ok", JSON.stringify(read));
    const alias = (read as { data: { alias: string } }).data.alias;
    const result = await edit(workspace, alias, patch("   first() {\n-    return 1;\n+    return 2;\n   }", "box.ts"));
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(await readFile(join(root, "box.ts"), "utf8"), "export class Box {\n  first() {\n    return 2;\n  }\n}\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("a patch without + or - lines is refused instead of reported as an edit", async () => {
  await fixture(async (workspace, root) => {
    const result = await workspace.editCode({ operations: [
      { kind: "patch", patch: patch("-  return 20;\n+  return 21;") },
      { kind: "patch", patch: patch(" export function first() {") },
    ] });
    assert.equal(result.status, "blocked");
    assert.match(String((result as { message: string }).message), /has no \+ or - line/u);
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), source);
  });
});
test("a final parse failure says where the edit's lines landed", async () => {
  await fixture(async (workspace, root) => {
    const result = await workspace.editCode({ operations: [{ kind: "patch", patch: patch(" export function first() {\n+export const broken = {") }] });
    assert.equal(result.status, "blocked");
    assert.match(String((result as { message: string }).message), /from line 3, after `export function first\(\) \{`/u);
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), source);
  });
});
test("wrong file headers keep their existing correction", async () => {
  await fixture(async (workspace, root, alias) => {
    const hint = recovery(await edit(workspace, alias, patch("-  return 1;\n+  return 2;", "other.ts")));
    assert.equal(hint.patchCorrection?.reason, "wrong_file_for_symbol");
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), source);
  });
});
test("CRLF and non-ASCII prefixes retain exact locations and preserve bytes on refusal", async () => {
  const text = ("// é🧪\n" + source).replaceAll("\n", "\r\n");
  await fixture(async (workspace, root, alias) => {
    const hint = recovery(await edit(workspace, alias, patch("-  return 20;\n+  return 21;")));
    assert.equal(hint.patchCorrection?.reason, "context_outside_symbol");
    assert.deepEqual(hint.patchCorrection.affectedLines, [[47, 47]]);
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), text);
  }, text);
});
test("dependent hunks still use the original batch preimage", async () => {
  await fixture(async (workspace, root, alias) => {
    const result = await workspace.editCode({ operations: [
      { kind: "symbol", target: alias, action: "replace_body", content: "return 2;" },
      { kind: "patch", target: alias, patch: patch("-  return 2;\n+  return 3;") },
    ] });
    assert.equal(recovery(result).patchCorrection, undefined);
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), source);
  });
});
test("over-budget files keep generic recovery instead of doing unbounded diagnostic work", async () => {
  const text = source + " ".repeat(512 * 1024);
  await fixture(async (workspace, root, alias) => {
    assert.equal(recovery(await edit(workspace, alias, patch("-  return 20;\n+  return 2;"))).patchCorrection, undefined);
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), text);
  }, text);
});
