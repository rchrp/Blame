import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LightWorkspace } from "./light-workspace.js";
test("an unchanged body edit gives a bounded route to changing the signature, without changing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-noop-body-"));
  const source = "export function value(_input: number) { return 1; }\n";
  try {
    await writeFile(join(root, "value.ts"), source);
    const workspace = new LightWorkspace(root, { sessionId: "noop" });
    await workspace.readCode({ target: "value.ts#value" }, {});
    const result = await workspace.editCode({ operations: [{ kind: "symbol", target: "value.ts#value", action: "replace_body", content: "return 1;" }] });
    assert.equal(result.status, "ok");
    const data = (result as { data: { changed: boolean; guidance: string; nextReads: {target:string;view:string}[] } }).data;
    assert.equal(data.changed, false);
    assert.match(data.guidance, /preserves parameters/);
    assert.equal(data.nextReads.length, 1);
    assert.equal(data.nextReads[0]?.view, "symbol");
    assert.equal(await readFile(join(root, "value.ts"), "utf8"), source);
    assert.equal((await workspace.readCode(data.nextReads[0]! as {target:string;view:"symbol"}, {})).status, "ok");
  } finally { await rm(root, { recursive: true, force: true }); }
});
