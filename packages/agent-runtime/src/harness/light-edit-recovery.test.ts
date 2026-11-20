import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LightToolResult } from "./light-contracts.js";
import { LightWorkspace } from "./test-client/light-workspace.js";
const source = "/** old documentation */\nexport function value() {\n  return 1;\n}\n";
const patch = (text: string, path = "value.ts") => `*** Begin Patch\n*** Update File: ${path}\n@@\n${text}\n*** End Patch`;
async function fixture(run: (root: string, workspace: LightWorkspace, alias: string) => Promise<void>, observed = true) {
  const root = await mkdtemp(join(tmpdir(), "blame-edit-hint-"));
  try {
    await writeFile(join(root, "value.ts"), source);
    const workspace = new LightWorkspace(root, { sessionId: "edit-hint" });
    const result = observed ? await workspace.readCode({ target: "value.ts#value" }, {})
      : await workspace.searchCode({ query: "value", mode: "symbol" });
    assert.equal(result.status, "ok");
    const data = (result as { data: { alias?: string; results?: { alias: string }[] } }).data;
    await run(root, workspace, data.alias ?? data.results![0]!.alias);
  } finally { await rm(root, { recursive: true, force: true }); }
}
function hint(result: LightToolResult<unknown>) {
  assert.equal(result.status, "blocked", JSON.stringify(result));
  const recovery = (result as { recovery?: string }).recovery ?? "";
  assert.match(recovery, /No operations in this batch were applied/u);
  assert.match(recovery, /original source/u);
  const parsed = JSON.parse(recovery.slice(recovery.indexOf("{")));
  assert.equal(parsed.path, "value.ts");
  assert.equal(parsed.nextRead.view, "range");
  assert.ok(parsed.nextRead.range.endLine - parsed.nextRead.range.startLine < 30);
  assert.match(parsed.routes, /file patch/u);
  assert.match(parsed.routes, /not observed edit coverage/u);
  return parsed;
}
test("a rejected JSDoc scoped patch supplies a bounded file route without authorizing unseen edits", async () => {
  await fixture(async (root, workspace, alias) => {
    const edit = { operations: [{ kind: "patch" as const, target: alias,
      patch: patch("-/** old documentation */\n+/** new documentation */") }] };
    const result = await workspace.editCode(edit);
    const recovery = hint(result);
    assert.equal(await readFile(join(root,"value.ts"),"utf8"), source);
    // File patches already use exact preimage guards; unlike alias edits they do not require symbol observation.
    await workspace.readCode(recovery.nextRead, {});
    assert.equal((await workspace.editCode({ operations: [{ kind: "patch", path: "value.ts", patch: edit.operations[0]!.patch }] })).status,"ok");
    assert.equal(await readFile(join(root,"value.ts"),"utf8"),source.replace("old documentation","new documentation"));
  });
});
test("dependent operations preserve the original batch base and recover through separate commits", async () => {
  await fixture(async (root, workspace, alias) => {
    const first = { kind: "symbol" as const, target: alias, action: "replace_body" as const, content: "{\n  return 2;\n}" };
    const second = { kind: "patch" as const, target: alias, patch: patch("-  return 2;\n+  return 3;") };
    hint(await workspace.editCode({ operations: [first, second] }));
    assert.equal(await readFile(join(root,"value.ts"),"utf8"),source);
    assert.equal((await workspace.editCode({ operations: [first] })).status,"ok");
    await workspace.readCode({target:"value.ts#value"},{});
    assert.equal((await workspace.editCode({ operations: [second] })).status,"ok");
    assert.match(await readFile(join(root,"value.ts"),"utf8"),/return 3;/u);
  });
});
test("a wrong header reports the actual target and never writes the other file", async () => {
  await fixture(async (root, workspace, alias) => {
    await writeFile(join(root,"other.ts"),source);
    const recovery=hint(await workspace.editCode({operations:[{kind:"patch",target:alias,patch:patch("-  return 1;\n+  return 2;","other.ts")}]}));
    assert.equal(recovery.target,alias);
    assert.equal(await readFile(join(root,"other.ts"),"utf8"),source);
  });
});
test("the recovery range remains a hint after an external source change", async () => {
  await fixture(async (root, workspace, alias) => {
    hint(await workspace.editCode({operations:[{kind:"patch",target:alias,patch:patch("-missing\n+replacement")}]}));
    await writeFile(join(root,"value.ts"),source.replace("return 1","return 9"));
    assert.equal((await workspace.editCode({operations:[{kind:"symbol",target:alias,action:"replace_body",content:"return 3;"}]})).status,"blocked");
    assert.match(await readFile(join(root,"value.ts"),"utf8"),/return 9/u);
  });
});
test("search-only target recovery does not grant body coverage", async () => {
  await fixture(async (root, workspace, alias) => {
    hint(await workspace.editCode({operations:[{kind:"patch",target:alias,patch:patch("-  return 1;\n+  return 2;")}]}));
    assert.equal((await workspace.editCode({operations:[{kind:"symbol",target:alias,action:"replace_body",content:"return 3;"}]})).status,"blocked");
    assert.equal(await readFile(join(root,"value.ts"),"utf8"),source);
    await workspace.readCode({target:alias},{});
    assert.equal((await workspace.editCode({operations:[{kind:"symbol",target:alias,action:"replace_body",content:"return 3;"}]})).status,"ok");
  },false);
});
