import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { data, fixture } from "./light-agent-guidance-fixture.js";

const source = "export function clamp(value: number, { min, max }: { min: number; max: number }): number { return value; }\n";
test("body receipts show the actual destructured header, while keeping imports and parameter scope", async () => {
  await fixture({ "value.ts": source }, async (workspace, root) => {
    const symbol = data(await workspace.readCode({ target: "value.ts#clamp" }, {}));
    const result = data(await workspace.editCode({ operations: [{ kind: "symbol", target: symbol.alias,
      action: "replace_body", content: "return Math.min(max, Math.max(min, value));" }] }));
    assert.equal(result.changed, true);
    assert.equal(result.bodyEditContext.headers[0].header, source.slice(7, source.indexOf(" { return")));
    assert.equal(result.bodyEditContext.headers[0].truncated, false);
    assert.equal(result.bodyEditContext.scope, "headers_before_body_edits");
    assert.match(result.bodyEditContext.instruction, /does not add imports/u);
    const after = await readFile(join(root, "value.ts"), "utf8");
    assert.equal(after.slice(0, after.indexOf(" { return")), source.slice(0, source.indexOf(" { return")));
  });
});

test("binding mistakes are shown with the preserved header and still require a real compiler check", async () => {
  await fixture({ "value.ts": source }, async (workspace, root) => {
    await workspace.readCode({ target: "value.ts#clamp" }, {});
    const result = await workspace.editCode({ operations: [{ kind: "symbol", target: "value.ts#clamp",
      action: "replace_body", content: "{ const { min, max } = limits; return value; }" }] });
    assert.equal(result.status, "ok", "Syntax-only admission does not establish type correctness");
    assert.match(JSON.stringify(result), /headers_before_body_edits/u);
    const compiled = spawnSync(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc"),
      "--noEmit", "--skipLibCheck", join(root, "value.ts")], { encoding: "utf8" });
    assert.equal(compiled.status, 2);
    assert.match(compiled.stdout, /Duplicate identifier|Cannot redeclare|Cannot find name/u);
    // A later deliberate complete declaration edit remains possible.
    data(await workspace.editCode({ operations: [{ kind: "symbol", target: "value.ts#clamp", action: "replace",
      content: "export function clamp(value: number, limits: { min: number; max: number }): number { return Math.min(limits.max, Math.max(limits.min, value)); }" }] }));
  });
});

test("a syntactically rejected body includes the observed header and writes nothing", async () => {
  await fixture({ "value.ts": source }, async (workspace, root) => {
    await workspace.readCode({ target: "value.ts#clamp" }, {});
    const result = await workspace.editCode({ operations: [{ kind: "symbol", target: "value.ts#clamp",
      action: "replace_body", content: "{ return value; } }" }] });
    assert.equal(result.status, "blocked");
    assert.match(JSON.stringify(result), /headers_before_body_edits/u);
    assert.equal(await readFile(join(root, "value.ts"), "utf8"), source);
  });
});

test("long Unicode headers and multiple body edits have bounded, explicit feedback", async () => {
  const text = Array.from({ length: 6 }, (_, i) => `export function f${i}(${"é".repeat(550)}: number) { return 1; }`).join("\n");
  await fixture({ "value.ts": text }, async workspace => {
    for (let i = 0; i < 6; i++) await workspace.readCode({ target: `value.ts#f${i}` }, {});
    const result = data(await workspace.editCode({ operations: Array.from({ length: 6 }, (_, i) => ({
      kind: "symbol" as const, target: `value.ts#f${i}`, action: "replace_body" as const, content: "return 2;",
    })) }));
    assert.equal(result.bodyEditContext.headers.length, 4);
    assert.equal(result.bodyEditContext.omitted, 2);
    for (const entry of result.bodyEditContext.headers) {
      assert.equal(Array.from(entry.header).length, 512);
      assert.equal(entry.truncated, true);
      assert.doesNotMatch(entry.header, /\uFFFD/u);
    }
  });
});

test("file patches do not get symbolic-body claims", async () => {
  await fixture({ "value.ts": source }, async workspace => {
    await workspace.readCode({ target: "value.ts", view: "raw" }, {});
    const result = data(await workspace.editCode({ operations: [{ kind: "patch", path: "value.ts",
      patch: `*** Begin Patch\n*** Update File: value.ts\n@@\n-${source.trimEnd()}\n+${source.trimEnd().replace("return value", "return value + 1")}\n*** End Patch` }] }));
    assert.equal(result.bodyEditContext, undefined);
  });
});
