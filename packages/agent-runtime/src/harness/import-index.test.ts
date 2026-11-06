import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ImportIndex } from "./import-index.js";
import { WorkspaceFiles } from "./workspace-files.js";

type Links = (path: string, focus?: string[], budget?: number) => Promise<string | undefined>;

async function workspace(files: Record<string, string>, run: (links: Links, root: string, index: ImportIndex) => Promise<void>, git = false) {
  const root = await mkdtemp(join(tmpdir(), "import-index-"));
  try {
    await write(root, files);
    if (git) commit(root, "initial", true);
    const index = new ImportIndex(new WorkspaceFiles(root));
    const links: Links = async (path, focus = [], budget) =>
      index.briefLinks(path, await readFile(join(root, path)), new Set(focus), undefined, budget ? { budget } : {});
    await run(links, root, index);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

function commit(root: string, message: string, init = false) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  if (init) git(["init", "-q"]);
  git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message]);
}

const math = "export function add(a: number, b: number) { return a + b; }\nexport function mul(a: number) { return a; }\nexport type Shape = { side: number };\nexport const unused = 1;\n";

test("relative imports resolve .js to .ts and report the first use line, not the import", async () => {
  await workspace({
    "src/math.ts": math,
    "src/calc.ts": 'import { add } from "./math.js";\n\nconst x = Math.add;\nexport const y = add(1, 2);\n',
    "src/other.ts": 'import { add as plus, mul } from "./math";\nimport type { Shape } from "./math.js";\nmul(1);\nplus(1, 2);\nexport const s: Shape = { side: 1 };\n',
    "src/lazy.mjs": 'const { mul } = await import("./math.js");\nconsole.log(mul(2));\n',
  }, async (links) => {
    assert.equal(await links("src/math.ts"), "add ← calc.ts:4, other.ts:4 · mul ← lazy.mjs:2, other.ts:3");
    assert.equal(await links("src/calc.ts"), undefined);
  });
});

test("barrels and namespace imports count as users of the defining file", async () => {
  await workspace({
    "src/lib/impl.ts": "export function widget() { return 1; }\nexport class Gadget {}\n",
    "src/lib/helper.ts": "export default function helper() { return 2; }\n",
    "src/lib/index.ts": 'export * from "./impl.js";\nexport { default as aidHelper } from "./helper.js";\n',
    "src/api.ts": 'import { Gadget } from "./lib/impl.js";\nexport { Gadget };\n',
    "src/app.ts": 'import { widget, aidHelper } from "./lib/index.js";\nimport { Gadget } from "./api.js";\n\nwidget();\naidHelper();\nnew Gadget();\n',
    "src/ns.ts": 'import * as lib from "./lib";\n\n\nexport const n = lib.widget();\n',
  }, async (links) => {
    assert.equal(await links("src/lib/impl.ts"), "Gadget ← app.ts:6 · widget ← app.ts:4, ns.ts:4");
    assert.equal(await links("src/lib/helper.ts"), "helper ← app.ts:5");
    assert.equal(await links("src/lib/index.ts"), "aidHelper ← app.ts:5 · widget ← app.ts:4, ns.ts:4");
  });
});

test("package imports, tsconfig paths and workspace packages resolve to source files", async () => {
  await workspace({
    "package.json": '{"name":"root","private":true}',
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "packages/core/package.json": JSON.stringify({
      name: "@acme/core",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./extra": "./dist/extra.js" },
      imports: { "#internal/*": "./src/internal/*.js" },
    }),
    "packages/core/src/index.ts": 'export { coreThing } from "./thing.js";\n',
    "packages/core/src/thing.ts": "export function coreThing() { return 1; }\n",
    "packages/core/src/extra.ts": "export const extraValue = 1;\n",
    "packages/core/src/internal/secret.ts": "export const secret = 2;\n",
    "packages/core/src/consumer.ts": 'import { secret } from "#internal/secret";\nexport const s = secret;\n',
    "packages/web/package.json": '{"name":"@acme/web"}',
    "packages/web/tsconfig.json": '{\n  // solution-style comments are fine\n  "compilerOptions": { "paths": { "@/*": ["./src/*"] } }\n}\n',
    "packages/web/src/util/format.ts": 'export function format() { return ""; }\n',
    "packages/web/src/page.tsx": 'import { coreThing } from "@acme/core";\nimport { extraValue } from "@acme/core/extra";\nimport { format } from "@/util/format";\nexport function Page() { return <p>{coreThing() + extraValue + format()}</p>; }\n',
  }, async (links) => {
    assert.equal(await links("packages/core/src/thing.ts"), "coreThing ← page.tsx:4");
    assert.equal(await links("packages/core/src/extra.ts"), "extraValue ← page.tsx:4");
    assert.equal(await links("packages/core/src/internal/secret.ts"), "secret ← consumer.ts:2");
    assert.equal(await links("packages/web/src/util/format.ts"), "format ← page.tsx:4");
  });
});

test("focus ranks first, then exports with the fewest users; many users collapse to a count", async () => {
  const users = Object.fromEntries(Array.from({ length: 7 }, (_, n) =>
    [`src/user${n}.ts`, `import { common${n < 2 ? ", rare" : ""} } from "./shared.js";\ncommon();\n${n < 2 ? "rare();\n" : ""}`]));
  await workspace({
    "src/shared.ts": "export function common() {}\nexport function rare() {}\n",
    ...users,
  }, async (links) => {
    assert.equal(await links("src/shared.ts"), "rare ← user0.ts:3, user1.ts:3 · common ← 7 files");
    assert.equal(await links("src/shared.ts", ["common"]), "common ← 7 files · rare ← user0.ts:3, user1.ts:3");
  });
});

test("colliding basenames use the shortest unambiguous path suffix", async () => {
  await workspace({
    "src/value.ts": "export const value = 1;\n",
    "src/a/util.ts": 'import { value } from "../value.js";\nexport const a = value;\n',
    "src/b/util.ts": 'import { value } from "../value.js";\n\nexport const b = value;\n',
    "src/c/deep/util.ts": "export const unrelated = 1;\n",
  }, async (links) => {
    assert.equal(await links("src/value.ts"), "value ← a/util.ts:2, b/util.ts:3");
  });
});

test("the budget cuts at a clean boundary and still makes room for tests", async () => {
  const names = ["alpha", "bravo", "charlie", "delta"];
  await workspace({
    "src/many.ts": names.map((name) => `export const ${name} = 1;\n`).join(""),
    "src/one.ts": `import { ${names.join(", ")} } from "./many.js";\n${names.join(";\n")};\n`,
    "src/two.ts": `import { alpha, bravo, charlie } from "./many.js";\n\n${names.slice(0, 3).join(";\n")};\n`,
    "src/three.ts": 'import { alpha } from "./many.js";\nalpha;\n',
    "src/many.test.ts": 'import { alpha } from "./many.js";\nalpha;\n',
  }, async (links) => {
    assert.equal(await links("src/many.ts"),
      "delta ← one.ts:5 · bravo ← one.ts:3, two.ts:4 · charlie ← one.ts:4, two.ts:5 · alpha ← one.ts:2, three.ts:2, two.ts:3 · tests: many.test.ts");
    assert.equal(await links("src/many.ts", [], 60), "delta ← one.ts:5 · bravo ← one.ts:3 +1 · tests: many.test.ts");
    assert.equal(await links("src/many.ts", [], 20), "tests: many.test.ts");
    assert.equal(await links("src/many.ts", [], 10), undefined);
  });
});

test("source files list the tests that import them; tests name their subject", async () => {
  await workspace({
    "src/parser.ts": "export function parse() { return 1; }\n",
    "src/parser.test.ts": 'import { parse } from "./parser.js";\nparse();\n',
    "src/other.spec.ts": 'import "./parser.js";\n',
    "src/__tests__/deep.ts": 'const { parse } = await import("../parser.js");\nparse();\n',
    "src/caller.ts": 'import { parse } from "./parser.js";\nexport const p = parse();\n',
    "src/format.ts": "export const format = 1;\n",
    "test/parser.test.ts": 'import { parse } from "../src/parser.js";\nimport { format } from "../src/format.js";\nparse(format);\n',
  }, async (links) => {
    assert.equal(await links("src/parser.ts"), "parse ← caller.ts:2 · tests: src/parser.test.ts, test/parser.test.ts +2");
    assert.equal(await links("src/parser.test.ts"), "subject: parser.ts");
    assert.equal(await links("test/parser.test.ts"), "subject: parser.ts");
    assert.equal(await links("src/__tests__/deep.ts"), "subject: parser.ts");
  });
});

test("updates incrementally after edits, additions, deletions and commits", async () => {
  await workspace({ "src/math.ts": math, "src/calc.ts": 'import { add } from "./math.js";\nadd(1, 2);\n', "src/keep.ts": 'import { mul } from "./math.js";\nmul(1);\n' },
    async (links, root, index) => {
      assert.equal(await links("src/math.ts"), "add ← calc.ts:2 · mul ← keep.ts:2");
      const entries = (index as unknown as { entries: Map<string, unknown> }).entries;
      const kept = entries.get("src/keep.ts");
      await write(root, { "src/calc.ts": 'import { add } from "./math.js";\n\n\nadd(1, 2);\n', "src/new.ts": 'import { add } from "./math";\nadd(3, 4);\n' });
      assert.equal(await links("src/math.ts"), "mul ← keep.ts:2 · add ← calc.ts:4, new.ts:2");
      assert.equal(entries.get("src/keep.ts"), kept, "an unchanged file is not reparsed");
      commit(root, "second");
      assert.equal(await links("src/math.ts"), "mul ← keep.ts:2 · add ← calc.ts:4, new.ts:2");
      await rm(join(root, "src/new.ts"));
      await write(root, { "src/keep.ts": "export const none = 1;\n" });
      assert.equal(await links("src/math.ts"), "add ← calc.ts:4");
      assert.equal(entries.get("src/math.ts") !== undefined, true);
    }, true);
});

test("only the JS/TS family is indexed; other files and declaration files return undefined", async () => {
  await workspace({
    "README.md": "# add\n",
    "src/types.d.ts": "export declare const x: number;\n",
    "src/style.css": ".add {}\n",
    "src/math.cts": "export function add() {}\n",
    "src/user.cjs": 'const { add } = require("./math.cjs");\nadd();\n',
    "src/schema.ts": "// This file is auto-generated. Do not edit.\nexport const add = 1;\n",
    "src/uses-schema.ts": 'import { add } from "./schema.js";\nadd;\n',
  }, async (links) => {
    assert.equal(await links("README.md"), undefined);
    assert.equal(await links("src/types.d.ts"), undefined);
    assert.equal(await links("src/style.css"), undefined);
    assert.equal(await links("src/schema.ts"), undefined);
    assert.equal(await links("src/math.cts"), "add ← user.cjs:2");
  });
});
