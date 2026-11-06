import assert from "node:assert/strict";
import test from "node:test";
import { data, fixture } from "./light-agent-guidance-fixture.js";

const steps = (name: string) =>
  Array.from({ length: 24 }, (_, index) => `  const ${name}${index} = compute("${name}", ${index});`).join("\n");

/** About 4,000 characters: four bodies worth folding, the first at lines 4–28. */
const service = [
  'import { compute } from "./compute.js";',
  `export function load() {\n${steps("load")}\n  return load0;\n}`,
  `export function save() {\n${steps("save")}\n  return save0;\n}`,
  `export function check() {\n${steps("check")}\n  return check0;\n}`,
  `export function needle() {\n${steps("needle")}\n  return "marker-needle";\n}`,
  "",
].join("\n\n");

const context = { agentId: "lead" };

test("a file whose folds pay for themselves comes back folded, a small one whole", async () => {
  await fixture({ "service.ts": service, "small.ts": "export const one = 1;\n" }, async (workspace) => {
    const folded = data(await workspace.readCode({ target: "service.ts" }, context));
    assert.equal(folded.view, "folded");
    assert.equal(folded.complete, false);
    assert.equal(folded.folded.hiddenParts, 4);
    // Every body uses compute: naming it on each marker would tell nothing.
    assert.match(folded.content, /^export function load\(\) \{\n {2}⋯ L4–28 · [\d.k]+ · s\d+\n\}$/mu);
    assert.equal(data(await workspace.readCode({ target: "small.ts" }, context)).view, "raw");
  });
});

test("folded bodies are not edit coverage until read", async () => {
  await fixture({ "service.ts": service }, async (workspace) => {
    const folded = data(await workspace.readCode({ target: "service.ts" }, context));
    const alias = /⋯ L4–28 · [\d.k]+ · (s\d+)/u.exec(folded.content)![1]!;
    const edit = { operations: [{ kind: "symbol" as const, target: alias, action: "replace_body" as const, content: "return 1;" }] };
    assert.equal((await workspace.editCode(edit)).status, "blocked");
    assert.match(data(await workspace.readCode({ target: alias }, context)).body, /load23/u);
    assert.equal((await workspace.editCode(edit)).status, "ok");
  });
});

test("a raw read right after a fold returns only the hidden lines, then nothing new", async () => {
  await fixture({ "service.ts": service }, async (workspace) => {
    const folded = data(await workspace.readCode({ target: "service.ts" }, context));
    const raw = data(await workspace.readCode({ target: "service.ts", view: "raw" }, context));
    assert.equal(raw.fallbackReason, "folded_view_delta");
    assert.equal(raw.segments.length, 4);
    assert.match(raw.segments[0].content, /load0 = compute/u);
    assert.doesNotMatch(JSON.stringify(raw.segments), /export function/u);
    assert.ok(raw.segments.reduce((sum: number, segment: { content: string }) => sum + segment.content.length, 0) +
      folded.content.length < service.length + 200);
    const again = data(await workspace.readCode({ target: "service.ts", view: "raw" }, context));
    assert.equal(again.status, "already_in_context");
    // Another agent has not seen the fold: it reads the whole file.
    assert.equal(data(await workspace.readCode({ target: "service.ts", view: "raw" }, { agentId: "other" })).complete, true);
  });
});

test("a body a search hit stays whole in a later fold", async () => {
  await fixture({ "service.ts": service }, async (workspace) => {
    await workspace.searchCode({ query: "marker-needle", mode: "text" });
    const folded = data(await workspace.readCode({ target: "service.ts" }, context));
    assert.match(folded.content, /return "marker-needle";/u);
    assert.equal(folded.folded.hiddenParts, 3);
    assert.match(folded.keptWhole[0], /search or check hit/u);
  });
});

test("an edit that copies a fold marker into source is refused", async () => {
  await fixture({ "service.ts": service }, async (workspace) => {
    const folded = data(await workspace.readCode({ target: "service.ts" }, context));
    const marker = folded.content.split("\n").find((line: string) => line.includes("⋯ L4–28"))!;
    const result = await workspace.editCode({ operations: [{ kind: "patch", path: "copy.ts", patch: `export function load() {\n${marker}\n}\n` }] });
    assert.equal(result.status, "blocked");
    assert.match(JSON.stringify(result), /folded-view line/u);
  });
});

test("several line ranges come back in one read", async () => {
  await fixture({ "service.ts": service }, async (workspace) => {
    const read = data(await workspace.readCode({ target: "service.ts", range: [{ startLine: 4, endLine: 5 }, { startLine: 30, endLine: 31 }] }, context));
    assert.equal(read.segments.length, 2);
    assert.deepEqual(read.segments.map((segment: { lines: number[] }) => segment.lines), [[4, 5], [30, 31]]);
  });
});

test("the first read of a file names who uses its exports, later reads do not repeat it", async () => {
  const files = {
    "helper.ts": "export function helper(value: number) {\n  return value + 1;\n}\n",
    "consumer.ts": 'import { helper } from "./helper.js";\n\nexport const result = helper(1);\n',
  };
  await fixture(files, async (workspace) => {
    const first = data(await workspace.readCode({ target: "helper.ts" }, context));
    assert.equal(first.links, "helper ← consumer.ts:3");
    assert.equal(data(await workspace.readCode({ target: "helper.ts" }, { agentId: "other" })).links, "helper ← consumer.ts:3");
    const again = await workspace.readCode({ target: "helper.ts", view: "raw" }, context);
    assert.equal(data(again).links, undefined);
  });
});
