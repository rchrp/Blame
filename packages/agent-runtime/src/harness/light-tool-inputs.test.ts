import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lightSearchCodeInputSchema, lightReadCodeInputSchema } from "./light-contracts.js";
import { lightSemanticHarnessTools, parseLeniently } from "./light-tools.js";
import { mkdir } from "node:fs/promises";

test("a number, object or array sent as a JSON string is read as what the schema expects", () => {
  const search = parseLeniently(lightSearchCodeInputSchema, { query: "alpha", limit: "100" });
  assert.equal(search.success, true);
  assert.equal(search.data?.limit, 100);
  const read = parseLeniently(lightReadCodeInputSchema, { target: "a.ts", range: '{"startLine":1,"endLine":5}' });
  assert.deepEqual(read.data?.range, { startLine: 1, endLine: 5 });
  assert.equal(parseLeniently(lightSearchCodeInputSchema, { query: "alpha", limit: "many" }).success, false);
});

test("run_task reads the shapes models give a project task, a run id or an inspect command", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-tool-inputs-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { check: "node -e \"console.log('checked')\"" } }));
    const tool = lightSemanticHarnessTools(root).find((candidate) => candidate.name === "run_task")!;
    const run = (input: unknown) => tool.execute(input, { agentId: "lead", iteration: 1 } as never).then((result: unknown) => JSON.stringify(result));
    for (const input of [{ kind: "task", task: "root:check" }, { task: "root:check" }])
      assert.doesNotMatch(await run(input), /Invalid discriminator|Unrecognized key/u, JSON.stringify(input));
    assert.match(await run({ kind: "inspect", run: "node -e \"console.log('ran')\"" }), /ran/u);
    assert.doesNotMatch(await run({ kind: "inspect", run: "7" }), /must match pattern/u);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "export const alpha = 1;\n");
    const search = lightSemanticHarnessTools(root).find((candidate) => candidate.name === "search_code")!;
    const found = JSON.stringify(await search.execute({ query: "alpha", scope: '["src"]', limit: "5" }, { agentId: "lead", iteration: 1 } as never));
    assert.match(found, /src\/a\.ts/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
