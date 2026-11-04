import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightWorkspace } from "./light-workspace.js";
import type { LightToolResult } from "./light-contracts.js";
import { WorkspaceFiles } from "./workspace-files.js";

const searches = [
  { query: "std::vector", decoy: "std::string", path: "std.txt" },
  { query: "xlink:href", decoy: "xlink:title", path: "xlink.txt" },
  { query: "https://api.example/v2", decoy: "https://other.example", path: "https.txt" },
  { query: '[data-state="open"]', decoy: 'data-state="closed"', path: "data-state.txt" },
  { query: "left+=right", decoy: "left = other", path: "left.txt" },
  { query: "failure|retry", decoy: "failure pending", path: "failure.txt" },
];

for (const engine of ["ripgrep", "node"])
  for (const search of searches)
    test(`${engine} preserves literal ${search.query} beyond prefix decoys`, async () => {
      await searchFixture(engine, search, async (workspace) => {
        const result = data(await workspace.searchCode({ query: search.query, mode: "text" }));
        const matches = result.results as Array<Record<string, unknown>>;
        assert.equal(matches.length, 1);
        assert.equal(matches[0]?.reason, "lexical_exact");
        assert.equal(matches[0]?.snippet, `target ${search.query}`);
        assert.deepEqual(matches[0]?.lines, [51, 51]);
        const read = data(await workspace.readCode({ target: String(matches[0]?.alias) }, {}));
        assert.ok(String(read.content).includes(search.query));
      });
    });

for (const engine of ["ripgrep", "node"])
  test(`${engine} keeps punctuation in whitespace-separated terms`, async () => {
    await searchFixture(engine, searches[0]!, async (workspace) => {
      const result = data(await workspace.searchCode({ query: "std::vector unavailable", mode: "text" }));
      const matches = result.results as Array<Record<string, unknown>>;
      assert.equal(matches.length, 1);
      assert.equal(matches[0]?.snippet, "target std::vector");
    });
  });

async function searchFixture(
  engine: string,
  search: { query: string; decoy: string; path: string },
  run: (workspace: LightWorkspace, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "blame-literal-search-"));
  const previous = process.env.BLAME_RIPGREP_COMMAND;
  if (engine === "node") process.env.BLAME_RIPGREP_COMMAND = join(root, "missing-rg");
  try {
    await writeFile(join(root, search.path), `${`${search.decoy}\n`.repeat(50)}target ${search.query}\n`);
    await run(new LightWorkspace(root, { sessionId: "literal-search" }), root);
  } finally {
    if (previous === undefined) delete process.env.BLAME_RIPGREP_COMMAND;
    else process.env.BLAME_RIPGREP_COMMAND = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function data(result: LightToolResult<unknown>) {
  assert.equal(result.status, "ok");
  return (result.status === "ok" ? result.data : {}) as Record<string, unknown>;
}

test("repeated hits in one symbol do not hide later symbols", async () => {
  await searchFixture("ripgrep", searches[0]!, async (workspace, root) => {
    await writeFile(join(root, "functions.ts"),
      `function first() { ${"needle(); ".repeat(12)} }\nfunction second() { needle(); }\nfunction third() { needle(); }\n`);
    const original = WorkspaceFiles.prototype.read;
    let reads = 0;
    WorkspaceFiles.prototype.read = function (path) {
      if (path === "functions.ts") reads += 1;
      return original.call(this, path);
    };
    try {
      const result = data(await workspace.searchCode({ query: "needle()" }));
      const names = (result.results as Array<{ qualifiedName: string }>).map(item => item.qualifiedName);
      assert.deepEqual(names, ["first", "second", "third"]);
      assert.equal(reads, 1);
    } finally {
      WorkspaceFiles.prototype.read = original;
    }
  });
});

for (const engine of ["ripgrep", "node"])
  test(`${engine} reports its result limit and actual engine`, async () => {
    await searchFixture(engine, searches[0]!, async (workspace, root) => {
      for (let index = 0; index < 12; index += 1)
        await writeFile(join(root, `entry-${index}.txt`), "needle");
      const result = data(await workspace.searchCode({ query: "needle", mode: "text" }));
      assert.equal((result.results as unknown[]).length, 8);
      assert.equal(result.engine, engine);
      assert.equal(result.limited, true);
      assert.match(String(result.guidance), /limit/iu);
    });
  });

for (const engine of ["ripgrep", "node"])
  test(`${engine} excludes oversized files consistently`, async () => {
    await searchFixture(engine, searches[0]!, async (workspace, root) => {
      await writeFile(join(root, "a-large.txt"), "needle" + " ".repeat(2 * 1024 * 1024));
      await writeFile(join(root, "z-small.txt"), "needle");
      const result = data(await workspace.searchCode({ query: "needle", mode: "text" }));
      assert.deepEqual((result.results as Array<{ path: string }>).map(item => item.path), ["z-small.txt"]);
      // Both engines scan every eligible file, so neither result is partial.
      assert.notEqual(result.limited, true);
    });
  });

test("the lexical collection limit stays visible after symbol deduplication", async () => {
  await searchFixture("ripgrep", searches[0]!, async (workspace, root) => {
    await writeFile(join(root, "functions.ts"), `function first() {\n${"  needle();\n".repeat(600)}}\n`);
    const result = data(await workspace.searchCode({ query: "needle()" }));
    assert.equal((result.results as unknown[]).length, 1);
    assert.equal(result.limited, true);
  });
});
