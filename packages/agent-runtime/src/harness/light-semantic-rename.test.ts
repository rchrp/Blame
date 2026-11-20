import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightWorkspace } from "./test-client/light-workspace.js";

const original =
  "export function calculate(n: number): number { return n + 1; }\n";
const config = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    types: [],
  },
  include: ["*.ts"],
};
async function fixture(
  run: (workspace: LightWorkspace, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "light-rename-"));
  try {
    await writeFile(join(root, "original.ts"), original);
    await writeFile(
      join(root, "consumer.ts"),
      'import { calculate as compute } from "./original.js";\nexport function use() { return compute(4); }\n',
    );
    await writeFile(
      join(root, "unrelated.ts"),
      'export function calculate(n: number) { return n - 1; }\nexport const label = "calculate";\n// calculate\n',
    );
    await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await run(new LightWorkspace(root, { sessionId: "semantic-rename" }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const read = (workspace: LightWorkspace) =>
  workspace.readCode({ target: "original.ts#calculate", view: "symbol" }, {});
const rename = (workspace: LightWorkspace, content = "updatedCalculation") =>
  workspace.editCode({
    operations: [
      {
        kind: "symbol",
        target: "original.ts#calculate",
        action: "rename",
        content,
      },
    ],
  });

test("native rename requires a fully observed target; discovery provides no edit coverage", async () => {
  await fixture(async (workspace, root) => {
    await workspace.searchCode({
      query: "original.ts#calculate",
      mode: "references",
    });
    assert.notEqual((await rename(workspace)).status, "ok");
    assert.equal(await readFile(join(root, "original.ts"), "utf8"), original);
  });
});
test("compiler rename preserves explicit aliases, homonyms, literals and comments", async () => {
  await fixture(async (workspace, root) => {
    const unrelated = await readFile(join(root, "unrelated.ts"), "utf8");
    await read(workspace);
    const result = await rename(workspace);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      await readFile(join(root, "original.ts"), "utf8"),
      original.replace("calculate", "updatedCalculation"),
    );
    assert.equal(
      await readFile(join(root, "consumer.ts"), "utf8"),
      'import { updatedCalculation as compute } from "./original.js";\nexport function use() { return compute(4); }\n',
    );
    assert.equal(await readFile(join(root, "unrelated.ts"), "utf8"), unrelated);
  });
});
test("unaliased imports and calls follow the new name", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(
      join(root, "consumer.ts"),
      'import { calculate } from "./original.js";\nexport const result = calculate(4);\n',
    );
    await read(workspace);
    const result = await rename(workspace);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      await readFile(join(root, "consumer.ts"), "utf8"),
      'import { updatedCalculation } from "./original.js";\nexport const result = updatedCalculation(4);\n',
    );
  });
});
test("stale declaration refuses replacement and preserves external edits", async () => {
  await fixture(async (workspace, root) => {
    await read(workspace);
    const external = original.replace("n + 1", "n + 99");
    await writeFile(join(root, "original.ts"), external);
    assert.notEqual((await rename(workspace)).status, "ok");
    assert.equal(await readFile(join(root, "original.ts"), "utf8"), external);
  });
});
test("capture in an imported caller blocks the whole batch", async () => {
  await fixture(async (workspace, root) => {
    const consumer =
      'import { calculate } from "./original.js";\nexport function use(updatedCalculation: number) { return calculate(4); }\n';
    await writeFile(join(root, "consumer.ts"), consumer);
    await read(workspace);
    const result = await rename(workspace);
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.match(JSON.stringify(result), /capture|diagnostics/u);
    assert.equal(await readFile(join(root, "consumer.ts"), "utf8"), consumer);
    assert.equal(await readFile(join(root, "original.ts"), "utf8"), original);
  });
});
test("invalid new identifiers, mixed operations and incomplete projects cannot write", async () => {
  await fixture(async (workspace, root) => {
    await read(workspace);
    for (const name of ["class", "two names", "a.b", "constructor", "\\u0061"])
      assert.equal((await rename(workspace, name)).status, "blocked", name);
    assert.equal(
      (
        await workspace.editCode({
          operations: [
            {
              kind: "symbol",
              target: "original.ts#calculate",
              action: "rename",
              content: "updatedCalculation",
            },
            {
              kind: "symbol",
              target: "original.ts#calculate",
              action: "replace_body",
              content: "return 2;",
            },
          ],
        })
      ).status,
      "blocked",
    );
    await writeFile(
      join(root, "consumer.ts"),
      'import { missing } from "./absent.js";\n',
    );
    const result = await rename(workspace);
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.match(JSON.stringify(result), /incomplete/u);
    assert.equal(await readFile(join(root, "original.ts"), "utf8"), original);
  });
});
test("same-name rename is a no-op and never creates validation evidence", async () => {
  await fixture(async (workspace) => {
    await read(workspace);
    const result = await rename(workspace, "calculate");
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      (result as { data: { changed: boolean } }).data.changed,
      false,
    );
    assert.equal(
      JSON.stringify(result).includes("verification_admitted"),
      false,
    );
  });
});

test("shorthand properties preserve their public key and explicit re-export aliases", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(
      join(root, "consumer.ts"),
      'import { calculate } from "./original.js";\nexport const api = { calculate };\nexport { calculate as publicCalculate };\n',
    );
    await read(workspace);
    const result = await rename(workspace);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      await readFile(join(root, "consumer.ts"), "utf8"),
      'import { updatedCalculation } from "./original.js";\nexport const api = { calculate: updatedCalculation };\nexport { updatedCalculation as publicCalculate };\n',
    );
  });
});

test("member collisions are blocked and UTF8/BOM positions are preserved", async () => {
  await fixture(async (workspace, root) => {
    const source =
      "\uFEFF// é🦊\nexport class C { calculate() { return 1; } occupied() { return 2; } }\n";
    await writeFile(join(root, "original.ts"), source);
    await writeFile(
      join(root, "consumer.ts"),
      'import { C } from "./original.js";\nexport const n = new C().calculate();\n',
    );
    await workspace.readCode(
      { target: "original.ts#C.calculate", view: "symbol" },
      {},
    );
    const op = (content: string) =>
      workspace.editCode({
        operations: [
          {
            kind: "symbol",
            target: "original.ts#C.calculate",
            action: "rename",
            content,
          },
        ],
      });
    assert.equal((await op("occupied")).status, "blocked");
    assert.equal(await readFile(join(root, "original.ts"), "utf8"), source);
    const result = await op("updatedCalculation");
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      await readFile(join(root, "original.ts"), "utf8"),
      source.replace("calculate", "updatedCalculation"),
    );
    assert.match(
      await readFile(join(root, "consumer.ts"), "utf8"),
      /\.updatedCalculation\(\)/u,
    );
  });
});

test("caller modified during planning is preserved and the batch cannot commit", async () => {
  await fixture(async (workspace, root) => {
    await read(workspace);
    const external =
      'import { calculate as compute } from "./original.js";\nexport function use() { return compute(99); }\n';
    const pending = rename(workspace);
    await new Promise((done) => setTimeout(done, 100));
    await writeFile(join(root, "consumer.ts"), external);
    const result = await pending;
    assert.notEqual(result.status, "ok", JSON.stringify(result));
    assert.equal(await readFile(join(root, "consumer.ts"), "utf8"), external);
    assert.equal(await readFile(join(root, "original.ts"), "utf8"), original);
  });
});

test("missing configuration and a rename above the 50-file limit leave all source intact", async () => {
  await fixture(async (workspace, root) => {
    await read(workspace);
    await rm(join(root, "tsconfig.json"));
    assert.equal((await rename(workspace)).status, "blocked");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
    for (let index = 0; index < 50; index++)
      await writeFile(
        join(root, `caller${index}.ts`),
        'import { calculate } from "./original.js";\nexport const n = calculate(1);\n',
      );
    assert.equal((await rename(workspace)).status, "blocked");
    assert.equal(await readFile(join(root, "original.ts"), "utf8"), original);
    assert.match(
      await readFile(join(root, "caller0.ts"), "utf8"),
      /\bcalculate\(1\)/u,
    );
  });
});

test("cancelled rename cannot write and an existing diagnostic is not a new regression", async () => {
  await fixture(async (workspace, root) => {
    const source = original + 'const known: number = "preexisting";\n';
    await writeFile(join(root, "original.ts"), source);
    await read(workspace);
    const abort = new AbortController();
    const pending = workspace.editCode(
      {
        operations: [
          {
            kind: "symbol",
            target: "original.ts#calculate",
            action: "rename",
            content: "updatedCalculation",
          },
        ],
      },
      { signal: abort.signal },
    );
    abort.abort(new Error("local cancellation control"));
    assert.notEqual((await pending).status, "ok");
    assert.equal(await readFile(join(root, "original.ts"), "utf8"), source);
    const result = await rename(workspace);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(
      await readFile(join(root, "original.ts"), "utf8"),
      source.replace("calculate", "updatedCalculation"),
    );
  });
});

test("jsconfig native rename works without granting arbitrary unseen body coverage", async () => {
  await fixture(async (workspace, root) => {
    await rm(join(root, "tsconfig.json"));
    await rm(join(root, "original.ts"));
    await rm(join(root, "consumer.ts"));
    await writeFile(
      join(root, "jsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          noEmit: true,
          types: [],
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["*.js"],
      }),
    );
    await writeFile(
      join(root, "original.js"),
      "export function calculate(n) { return n + 1; }\n",
    );
    await writeFile(
      join(root, "consumer.js"),
      'import { calculate as compute } from "./original.js";\nexport function use() { return compute(4); }\n',
    );
    await workspace.readCode(
      { target: "original.js#calculate", view: "symbol" },
      {},
    );
    const result = await workspace.editCode({
      operations: [
        {
          kind: "symbol",
          target: "original.js#calculate",
          action: "rename",
          content: "updatedCalculation",
        },
      ],
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.match(
      await readFile(join(root, "consumer.js"), "utf8"),
      /updatedCalculation as compute/u,
    );
    await workspace.searchCode({
      query: "use",
      mode: "symbol",
      scope: "consumer.js",
    });
    assert.equal(
      (
        await workspace.editCode({
          operations: [
            {
              kind: "symbol",
              target: "consumer.js#use",
              action: "replace_body",
              content: "return 0;",
            },
          ],
        })
      ).status,
      "blocked",
    );
  });
});

test("JS targets shadowed by TS sources are blocked instead of inferring runtime identity", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        ...config,
        compilerOptions: {
          ...config.compilerOptions,
          allowJs: true,
        },
        include: ["*.ts", "*.js"],
      }),
    );
    const source = "export function calculate(n) { return n + 1; }\n";
    await writeFile(join(root, "original.js"), source);
    await workspace.readCode(
      { target: "original.js#calculate", view: "symbol" },
      {},
    );
    const result = await workspace.editCode({
      operations: [
        {
          kind: "symbol",
          target: "original.js#calculate",
          action: "rename",
          content: "updatedCalculation",
        },
      ],
    });
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(await readFile(join(root, "original.js"), "utf8"), source);
  });
});
