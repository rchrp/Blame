import assert from "node:assert/strict";
import test from "node:test";
import { data, fixture } from "./light-agent-guidance-fixture.js";

type Result = Record<string, unknown> & { path: string };

const engines = ["ripgrep", "node"] as const;

async function withEngine(engine: (typeof engines)[number], run: () => Promise<void>) {
  const previous = process.env.BLAME_RIPGREP_COMMAND;
  if (engine === "node") process.env.BLAME_RIPGREP_COMMAND = "/nonexistent/blame-missing-rg";
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.BLAME_RIPGREP_COMMAND;
    else process.env.BLAME_RIPGREP_COMMAND = previous;
  }
}

const attachmentsFolder = Object.fromEntries(
  ["canvas", "model", "renderer", "toolbar", "file", "format", "preview", "types", "upload"].map((name) => [
    `src/components/attachments/${name}.ts`,
    `export const ${name} = 1;\n`,
  ]),
);

for (const engine of engines) {
  test(`${engine}: a page too large for one result stops early and continues where it stopped`, async () => {
    const source = `${Array.from({ length: 400 }, (_, index) => `export const needle${index} = "${"x".repeat(90)}";`).join("\n")}\n`;
    await withEngine(engine, () => fixture({ "src/long.ts": source }, async (workspace) => {
      const input = { query: "needle", mode: "text" as const, scope: "src", context: 30, limit: 100 };
      const first = data(await workspace.searchCode(input));
      const firstLines = (first.results as Result[]).map((item) => (item.lines as number[])[0]!);
      assert.ok(firstLines.length > 1 && firstLines.length < 100);
      assert.ok(JSON.stringify(first.results).length <= 40_000);
      assert.match(String(first.guidance), /size limit/);
      assert.deepEqual(first.nextSearch, { ...input, offset: firstLines.length });
      const second = data(await workspace.searchCode(first.nextSearch as typeof input));
      const secondLines = (second.results as Result[]).map((item) => (item.lines as number[])[0]!);
      assert.equal(secondLines[0], firstLines.at(-1)! + 1);
    }));
  });

  test(`${engine}: a folder name shared with one term does not crowd out content matches`, async () => {
    await withEngine(engine, () => fixture({
      ...attachmentsFolder,
      "src/code/file-view.ts": "// line selection lives in the gutter\nexport const view = 1;\n",
    }, async (workspace) => {
      const found = data(await workspace.searchCode({ query: "line selection gutter attachment", scope: "src" }));
      const results = found.results as Result[];
      assert.equal(results[0]?.path, "src/code/file-view.ts");
      assert.ok(!results.some((item) => item.reason === "path_name"));
    }));
  });

  test(`${engine}: files containing more query terms rank before busier single-term files`, async () => {
    await withEngine(engine, () => fixture({
      "a-busy.txt": "alpha\n".repeat(40),
      "z-complete.txt": "alpha beta gamma\n",
    }, async (workspace) => {
      const found = data(await workspace.searchCode({ query: "alpha beta gamma", mode: "text" }));
      assert.equal((found.results as Result[])[0]?.path, "z-complete.txt");
    }));
  });

  test(`${engine}: regex mode lists each matching line in path order`, async () => {
    await withEngine(engine, () => fixture({
      "b.ts": "const fooValue = 1;\nconst other = 2;\nconst barValue = 3;\n",
      "a.ts": "export const barTop = 1;\n",
    }, async (workspace) => {
      const found = data(await workspace.searchCode({ query: "foo\\w+|bar\\w+", mode: "regex" }));
      const results = found.results as Array<Result & { lines: number[]; snippet: string }>;
      assert.deepEqual(results.map((item) => [item.path, item.lines[0]]), [["a.ts", 1], ["b.ts", 1], ["b.ts", 3]]);
      assert.equal(found.mode, "regex");
    }));
  });

  test(`${engine}: files and count outputs cover every matching file`, async () => {
    const files = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`f-${String(index).padStart(2, "0")}.txt`, "needle\nneedle\n"]));
    await withEngine(engine, () => fixture(files, async (workspace) => {
      const listed = data(await workspace.searchCode({ query: "needle", output: "files" }));
      assert.equal(listed.totalFiles, 60);
      assert.equal(listed.totalMatchingLines, 120);
      assert.equal((listed.files as unknown[]).length, 50);
      assert.deepEqual((listed.files as Array<{ matchingLines: number }>)[0]?.matchingLines, 2);
      const rest = data(await workspace.searchCode(listed.nextSearch));
      assert.equal((rest.files as unknown[]).length, 10);
      assert.equal(rest.limited, undefined);
      const counted = data(await workspace.searchCode({ query: "needle", output: "count" }));
      assert.equal(counted.totalFiles, 60);
      assert.equal(counted.totalMatchingLines, 120);
      assert.equal(counted.files, undefined);
    }));
  });
}

test("paging with nextSearch continues without repeating results", async () => {
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`entry-${String(index).padStart(2, "0")}.txt`, "needle\n"]));
  await fixture(files, async (workspace) => {
    const first = data(await workspace.searchCode({ query: "needle", mode: "text" }));
    assert.equal((first.results as unknown[]).length, 8);
    assert.equal(first.limited, true);
    const second = data(await workspace.searchCode(first.nextSearch));
    assert.deepEqual(first.nextSearch, { query: "needle", mode: "text", offset: 8 });
    const paths = [...first.results as Result[], ...second.results as Result[]].map((item) => item.path);
    assert.equal(new Set(paths).size, 12);
    assert.equal(second.limited, undefined);
  });
});

test("context shows surrounding lines in grep style", async () => {
  await fixture({ "notes.txt": "one\ntwo\nthree marker\nfour\nfive\n" }, async (workspace) => {
    const found = data(await workspace.searchCode({ query: "marker", mode: "text", context: 1 }));
    assert.equal((found.results as Array<{ context: string }>)[0]?.context, "2-two\n3:three marker\n4-four");
  });
});

test("case is ignored unless caseSensitive is set", async () => {
  await fixture({ "case.txt": "Needle\nneedle\n" }, async (workspace) => {
    const loose = data(await workspace.searchCode({ query: "Needle", mode: "regex" }));
    assert.equal((loose.results as unknown[]).length, 2);
    const strict = data(await workspace.searchCode({ query: "Needle", mode: "regex", caseSensitive: true }));
    assert.deepEqual((strict.results as Array<{ lines: number[] }>).map((item) => item.lines[0]), [1]);
  });
});

test("a match inside a declaration returns its alias and the matching line", async () => {
  await fixture({ "service.ts": "export function load(id: string) {\n  const value = fetchRecord(id);\n  return value;\n}\n" }, async (workspace) => {
    const found = data(await workspace.searchCode({ query: "fetchRecord(id)" }));
    const [match] = found.results as Array<Record<string, unknown>>;
    assert.equal(match?.qualifiedName, "load");
    assert.equal(match?.matchLine, 2);
    assert.equal(match?.snippet, "  const value = fetchRecord(id);");
    assert.equal(match?.signature, undefined);
    const read = data(await workspace.readCode({ target: String(match?.alias) }, {}));
    assert.match(String(read.body), /fetchRecord/u);
  });
});

test("an invalid regex is reported as an input problem", async () => {
  await fixture({ "a.txt": "value\n" }, async (workspace) => {
    const result = await workspace.searchCode({ query: "(unclosed", mode: "regex" });
    assert.equal(result.status, "blocked");
    assert.match(String((result as { message: string }).message), /Invalid regex/u);
  });
});
