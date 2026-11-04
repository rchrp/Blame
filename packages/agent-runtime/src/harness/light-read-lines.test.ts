import assert from "node:assert/strict";
import test from "node:test";
import { data, fixture } from "./light-agent-guidance-fixture.js";

const source = "export function first() {\n  return 1;\n}\n\nexport function second() {\n  return 2;\n}\n";

test("raw, range and symbol reads state the lines they hold", async () => {
  await fixture({ "lines.ts": source }, async (workspace) => {
    assert.deepEqual(data(await workspace.readCode({ target: "lines.ts", view: "raw" }, {})).lines, [1, 7]);
    const range = data(await workspace.readCode({ target: "lines.ts", range: { startLine: 5, endLine: 6 } }, {}));
    assert.deepEqual(range.lines, [5, 6]);
    assert.equal(range.content, "export function second() {\n  return 2;\n");
    assert.deepEqual(data(await workspace.readCode({ target: "lines.ts#second" }, {})).lines, [5, 7]);
  });
});

test("a file without a final newline still reports its last line", async () => {
  await fixture({ "short.txt": "one\ntwo" }, async (workspace) => {
    assert.deepEqual(data(await workspace.readCode({ target: "short.txt" }, {})).lines, [1, 2]);
  });
});
