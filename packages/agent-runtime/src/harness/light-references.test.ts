import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightWorkspace } from "./light-workspace.js";
import { LightAliasRegistry } from "./light-aliases.js";
import { LightReferenceSearch } from "./light-reference-search.js";
import { sha256 } from "./light-identity.js";
import { WorkspaceFiles } from "./workspace-files.js";
import {
  querySemanticReferences,
  referenceFootprintIsCurrent,
} from "./semantic-reference-client.js";

const source =
  "export function calculate(n: number): number { return n + 1; }\n";
const files = {
  "original.ts": source,
  "consumer.ts":
    'import { calculate as compute } from "./original.js";\nexport function use() { return compute(4); }\n',
  "unrelated.ts":
    'export function calculate(n: number) { return n - 1; }\nexport const label = "calculate";\n// calculate\n',
};
const config = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    types: [],
  },
  include: ["*.ts", "*.js"],
};
function data(result: Awaited<ReturnType<LightWorkspace["searchCode"]>>) {
  assert.equal(result.status, "ok", JSON.stringify(result));
  return (result as { data: Record<string, unknown> }).data;
}
async function fixture(
  run: (workspace: LightWorkspace, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "light-reference-"));
  try {
    for (const [path, text] of Object.entries(files))
      await writeFile(join(root, path), text);
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
    await run(
      new LightWorkspace(root, { sessionId: "semantic-references" }),
      root,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const references = (
  workspace: LightWorkspace,
  query = "original.ts#calculate",
  scope?: string,
) =>
  workspace.searchCode({
    query,
    mode: "references",
    ...(scope ? { scope } : {}),
  });

test("identity references follow an import alias and exclude unrelated homonyms/literals/comments", async () => {
  await fixture(async (workspace, root) => {
    const result = data(await references(workspace));
    assert.equal(result.engine, "typescript_language_service");
    assert.equal(result.referenceCount, 2);
    const hits = result.results as Array<{
      path: string;
      reference: { lines: number[] };
    }>;
    assert.deepEqual(
      hits.map((hit) => [hit.path, hit.reference.lines[0]]),
      [
        ["consumer.ts", 1],
        ["consumer.ts", 2],
      ],
    );
    assert.equal(result.completeness, "configured_project");
    assert.equal(
      (result.project as { compilerVersion: string }).compilerVersion,
      "5.9.3",
    );
    for (const [path, text] of Object.entries(files))
      assert.equal(await readFile(join(root, path), "utf8"), text);
  });
});

test("bare references remain honest lexical candidates; aliases identify the desired declaration", async () => {
  await fixture(async (workspace) => {
    const bare = data(await references(workspace, "calculate"));
    assert.equal(bare.engine, "lexical_fallback");
    assert.equal(bare.semanticFallback, "symbol_target_required");
    const symbol = data(
      await workspace.searchCode({
        query: "calculate",
        mode: "symbol",
        scope: "original.ts",
      }),
    );
    const alias = (symbol.results as Array<{ alias: string }>)[0]!.alias;
    assert.equal(data(await references(workspace, alias)).referenceCount, 2);
  });
});

test("scope filters returned references without changing the compiler project", async () => {
  await fixture(async (workspace) => {
    const result = data(
      await references(workspace, "original.ts#calculate", "unrelated.ts"),
    );
    assert.deepEqual(result.results, []);
    assert.equal(result.referenceCount, 0);
    assert.equal(result.limited, false);
    assert.equal((result.project as { rootFiles: number }).rootFiles, 3);
  });
});

test("reference discovery never grants unseen body-edit coverage", async () => {
  await fixture(async (workspace) => {
    await references(workspace);
    const result = await workspace.editCode({
      operations: [
        {
          kind: "symbol",
          target: "original.ts#calculate",
          action: "replace_body",
          content: "{ return n * 2; }",
        },
      ],
    });
    assert.equal(result.status, "blocked");
  });
});

test("external body changes remain protected after a semantic query refreshes symbol identity", async () => {
  await fixture(async (workspace, root) => {
    await workspace.readCode(
      { target: "original.ts#calculate", view: "symbol" },
      {},
    );
    await writeFile(
      join(root, "original.ts"),
      source.replace("n + 1", "n + 99"),
    );
    await references(workspace);
    const result = await workspace.editCode({
      operations: [
        {
          kind: "symbol",
          target: "original.ts#calculate",
          action: "replace_body",
          content: "{ return n * 2; }",
        },
      ],
    });
    assert.equal(result.status, "blocked");
    assert.match(await readFile(join(root, "original.ts"), "utf8"), /n \+ 99/u);
  });
});

test("fresh worker sees added references and changed project configuration", async () => {
  await fixture(async (workspace, root) => {
    assert.equal(data(await references(workspace)).referenceCount, 2);
    await writeFile(
      join(root, "added.ts"),
      'import { calculate } from "./original.js";\ncalculate(1);\n',
    );
    assert.equal(data(await references(workspace)).referenceCount, 4);
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ ...config, files: ["original.ts"], include: [] }),
    );
    assert.equal(data(await references(workspace)).referenceCount, 0);
  });
});

test("no or invalid config, and unsupported languages, expose labeled lexical fallback", async () => {
  await fixture(async (workspace, root) => {
    await rm(join(root, "tsconfig.json"));
    assert.equal(
      data(await references(workspace)).semanticFallback,
      "no_project_config",
    );
    await writeFile(
      join(root, "tsconfig.json"),
      '{"compilerOptions":{"target":"not-a-target"}}',
    );
    assert.equal(
      data(await references(workspace)).semanticFallback,
      "invalid_project_config",
    );
    await writeFile(
      join(root, "sample.py"),
      "def calculate(n):\n    return n + 1\n",
    );
    assert.equal(
      data(await references(workspace, "sample.py#calculate")).semanticFallback,
      "unsupported_language",
    );
  });
});

test("configured-project boundary rejects an excluded target", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ ...config, files: ["unrelated.ts"], include: [] }),
    );
    assert.equal(
      data(await references(workspace)).semanticFallback,
      "target_not_in_project",
    );
  });
});

test("missing imports report partial project, never full reference completeness", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(
      join(root, "missing.ts"),
      'import { value } from "./absent.js";\nexport { value };\n',
    );
    const result = data(await references(workspace));
    assert.equal(result.engine, "typescript_language_service");
    assert.equal(result.completeness, "partial_project");
    assert.ok(
      (result.project as { warnings: string[] }).warnings.includes(
        "unresolved_imports",
      ),
    );
  });
});

test("result limits remain visible and narrowing finds later references", async () => {
  await fixture(async (workspace, root) => {
    for (let index = 0; index < 10; index++)
      await writeFile(
        join(root, `use-${index}.ts`),
        'import { calculate } from "./original.js";\ncalculate(1);\n',
      );
    const result = data(await references(workspace));
    assert.equal((result.results as unknown[]).length, 8);
    assert.equal(result.referenceCount, 22);
    assert.equal(result.limited, true);
    assert.equal(
      data(await references(workspace, "original.ts#calculate", "use-9.ts"))
        .referenceCount,
      2,
    );
  });
});

test("UTF-8/BOM and non-ASCII prefix preserve compiler-to-byte offsets", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(join(root, "original.ts"), "\uFEFF// café 😀\n" + source);
    await writeFile(
      join(root, "consumer.ts"),
      '// café 😀\nimport { calculate as compute } from "./original.js";\ncompute(4);\n',
    );
    const result = data(await references(workspace));
    assert.deepEqual(
      (result.results as Array<{ reference: { lines: number[] } }>).map(
        (hit) => hit.reference.lines[0],
      ),
      [2, 3],
    );
  });
});

test("method identity follows class import aliases through re-exports", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(
      join(root, "original.ts"),
      "export class Counter { calculate(n: number) { return n + 1; } }\n",
    );
    await writeFile(
      join(root, "barrel.ts"),
      'export { Counter as WrappedCounter } from "./original.js";\n',
    );
    await writeFile(
      join(root, "consumer.ts"),
      'import { WrappedCounter as C } from "./barrel.js";\nexport const result = new C().calculate(4);\n',
    );
    const result = data(
      await references(workspace, "original.ts#Counter.calculate"),
    );
    assert.equal(result.engine, "typescript_language_service");
    assert.deepEqual(
      (
        result.results as Array<{
          path: string;
          reference: { lines: number[] };
        }>
      ).map((hit) => [hit.path, hit.reference.lines[0]]),
      [["consumer.ts", 2]],
    );
  });
});

test("JavaScript jsconfig project uses the same read-only identity mechanism", async () => {
  await fixture(async (workspace, root) => {
    await rm(join(root, "tsconfig.json"));
    await writeFile(
      join(root, "jsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          noEmit: true,
          types: [],
        },
        include: ["*.js"],
      }),
    );
    await writeFile(
      join(root, "script.js"),
      "export function calculate(n) { return n + 1; }\n",
    );
    await writeFile(
      join(root, "use.js"),
      'import { calculate as compute } from "./script.js";\ncompute(1);\n',
    );
    const result = data(await references(workspace, "script.js#calculate"));
    assert.equal(result.engine, "typescript_language_service");
    assert.equal(result.referenceCount, 2);
  });
});

test("project references are labeled and a navigation result is not validation proof", async () => {
  await fixture(async (workspace, root) => {
    await mkdir(join(root, "child"));
    await writeFile(
      join(root, "child/tsconfig.json"),
      JSON.stringify({ compilerOptions: { composite: true }, files: [] }),
    );
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ ...config, references: [{ path: "./child" }] }),
    );
    const result = data(await references(workspace));
    assert.equal(result.navigationOnly, true);
    assert.equal(result.completeness, "partial_project");
    assert.ok(
      (result.project as { warnings: string[] }).warnings.includes(
        "project_references_not_fully_expanded",
      ),
    );
  });
});

test("footprint freshness checks content and negative file lookups including directories", async () => {
  await fixture(async (_workspace, root) => {
    const path = join(root, "original.ts"),
      absent = join(root, "absent.ts"),
      folder = join(root, "directory.ts");
    await mkdir(folder);
    const footprint = {
      reads: [{ path, hash: sha256(source) }],
      existence: [
        { path: absent, exists: false },
        { path: folder, exists: false },
      ],
    };
    assert.equal(await referenceFootprintIsCurrent(footprint), true);
    await writeFile(absent, "export {};");
    assert.equal(await referenceFootprintIsCurrent(footprint), false);
    await rm(absent);
    await writeFile(path, source.replace("n + 1", "n + 99"));
    assert.equal(await referenceFootprintIsCurrent(footprint), false);
  });
});

test("reference worker has an outer timeout and cancellation releases it", async () => {
  await fixture(async (_workspace, root) => {
    const request = {
      root,
      target: {
        path: "original.ts",
        name: "calculate",
        start: 0,
        end: source.length,
        hash: sha256(source),
      },
    };
    assert.deepEqual(await querySemanticReferences(request, undefined, 1), {
      status: "unavailable",
      reason: "query_timeout",
    });
    const aborted = AbortSignal.abort(new Error("cancelled before dispatch"));
    await assert.rejects(
      querySemanticReferences(request, aborted),
      /cancelled before/u,
    );
    const controller = new AbortController();
    const pending = querySemanticReferences(request, controller.signal);
    controller.abort(new Error("cancelled during dispatch"));
    await assert.rejects(pending, /cancelled during/u);
  });
});

type DeclarationCandidate = { alias: string; target: string; path: string; qualifiedName: string; signature: string };
const declarations = (value: Record<string, unknown>) => value.declarationCandidates as DeclarationCandidate[];
const discovery = (value: Record<string, unknown>) => value.declarationDiscovery as {
  status: string; limited: boolean; visitedFiles: number; readBytes: number; skippedFiles: number;
};

test("bare references discover exact declarations beyond saturated lexical callers without choosing one", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(join(root, "a.ts"), 'import { calculate } from "./original.js";\n' +
      Array.from({ length: 10 }, (_, index) => `export function caller${index}() { return calculate(${index}); }`).join("\n"));
    const result = data(await references(workspace, "calculate"));
    assert.equal(result.engine, "lexical_fallback");
    assert.equal(result.semanticFallback, "symbol_target_required");
    assert.equal((result.results as Array<{ path: string }>).some(hit => hit.path === "original.ts"), false);
    assert.deepEqual(declarations(result).map(hit => [hit.path, hit.qualifiedName]),
      [["original.ts", "calculate"], ["unrelated.ts", "calculate"]]);
    assert.equal(discovery(result).status, "current");
    assert.equal(result.target, undefined);
    assert.match(String(result.guidance), /not compiler-resolved references.*Choose the intended declaration/u);
    const next = result.nextSearches as Array<{ query: string; mode: "references" }>;
    assert.deepEqual(next.map(search => search.query), declarations(result).map(hit => hit.target));
    assert.equal(data(await workspace.searchCode(next[0]!)).engine, "typescript_language_service");
  });
});

test("declaration candidates match case-sensitive exact names, including qualified methods", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(join(root, "a.ts"), "export function Calculate() {}\nexport function calculateLong() {}\n" +
      "export class Box { calculate() {} calculateLong() {} }\n");
    const result = data(await references(workspace, "calculate"));
    assert.deepEqual(declarations(result).map(hit => hit.qualifiedName), ["Box.calculate", "calculate", "calculate"]);
    const qualified = data(await references(workspace, "Box.calculate"));
    assert.deepEqual(declarations(qualified).map(hit => hit.qualifiedName), ["Box.calculate"]);
  });
});

test("declaration recovery obeys literal and array scopes and preserves them on explicit next searches", async () => {
  await fixture(async (workspace) => {
    const none = data(await references(workspace, "calculate", "consumer.ts"));
    assert.deepEqual(declarations(none), []);
    const scoped = data(await workspace.searchCode({ query: "calculate", mode: "references",
      scope: ["original.ts", "unrelated.ts"] }));
    assert.deepEqual(declarations(scoped).map(hit => hit.path), ["original.ts", "unrelated.ts"]);
    for (const next of scoped.nextSearches as Array<{ scope: string[] }>)
      assert.deepEqual(next.scope, ["original.ts", "unrelated.ts"]);
  });
});

test("homonymous candidate headers are capped without collapsing declarations into one identity", async () => {
  await fixture(async (workspace, root) => {
    for (let index = 0; index < 6; index++)
      await writeFile(join(root, `a-${index}.ts`), `export function calculate(n: number) { return n + ${index}; }\n`);
    const result = data(await references(workspace, "calculate"));
    assert.equal(declarations(result).length, 4);
    assert.equal(new Set(declarations(result).map(hit => hit.alias)).size, 4);
    assert.equal(discovery(result).limited, true);
    assert.equal((result.nextSearches as unknown[]).length, 4);
    assert.equal(declarations(result).some(hit => hit.path === "original.ts"), false);
    assert.deepEqual(declarations(data(await references(workspace, "calculate", "original.ts"))).map(hit => hit.path), ["original.ts"]);
  });
});

test("overload declarations use distinct aliases instead of ambiguous qualified next searches", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(join(root, "overload.ts"), "export interface Reader {\n" +
      "overloaded(n: number): number;\noverloaded(n: string): string;\n}\n");
    const result = data(await references(workspace, "overloaded", "overload.ts"));
    assert.equal(declarations(result).length, 2);
    assert.equal(new Set(declarations(result).map(hit => hit.alias)).size, 2);
    for (const candidate of declarations(result)) assert.equal(candidate.target, candidate.alias);
    for (const next of result.nextSearches as Array<{ query: string }>) assert.match(next.query, /^s\d+$/u);
    const first = declarations(result)[0]!, second = declarations(result)[1]!;
    assert.match(JSON.stringify(data(await workspace.readCode({ target: first.alias, view: "symbol" }, {}))), /n: number/u);
    assert.match(JSON.stringify(data(await workspace.readCode({ target: second.alias, view: "symbol" }, {}))), /n: string/u);
    const repeated = declarations(data(await references(workspace, "overloaded", "overload.ts")));
    assert.deepEqual(repeated.map(hit => hit.alias), [first.alias, second.alias]);
    await writeFile(join(root, "overload.ts"), "// shifted\nexport interface Reader {\n" +
      "overloaded(n: number): number;\noverloaded(n: string): string;\n}\n");
    assert.equal((await workspace.readCode({ target: first.alias, view: "symbol" }, {})).status, "blocked");
    const refreshed = declarations(data(await references(workspace, "overloaded", "overload.ts")));
    assert.equal(new Set(refreshed.map(hit => hit.alias)).size, 2);
    assert.ok(refreshed.every(hit => hit.alias !== first.alias && hit.alias !== second.alias));
  });
});

test("a unique declaration retains its reusable alias across unrelated source shifts", async () => {
  await fixture(async (workspace, root) => {
    const original = declarations(data(await references(workspace, "calculate", "original.ts")))[0]!;
    await writeFile(join(root, "original.ts"), "// shifted\n" + source);
    const refreshed = declarations(data(await references(workspace, "calculate", "original.ts")))[0]!;
    assert.equal(refreshed.alias, original.alias);
    assert.match(JSON.stringify(data(await workspace.readCode({ target: original.alias, view: "symbol" }, {}))), /n \+ 1/u);
  });
});

test("declaration file and byte budgets remain visible and explicit scopes recover later targets", async () => {
  await fixture(async (workspace, root) => {
    for (let index = 0; index < 64; index++)
      await writeFile(join(root, `a-${String(index).padStart(2, "0")}.ts`), "export {};\n");
    await writeFile(join(root, "z.ts"), "export function beyond() {}\n");
    const bounded = data(await references(workspace, "beyond"));
    assert.deepEqual(declarations(bounded), []);
    assert.equal(discovery(bounded).visitedFiles, 64);
    assert.equal(discovery(bounded).limited, true);
    assert.equal(declarations(data(await references(workspace, "beyond", "z.ts")))[0]?.qualifiedName, "beyond");
    for (let index = 0; index < 5; index++)
      await writeFile(join(root, `a-${String(index).padStart(2, "0")}.ts`), "//" + " ".repeat(230 * 1024) + "\n");
    const bytes = data(await references(workspace, "beyond"));
    assert.deepEqual(declarations(bytes), []);
    assert.equal(discovery(bytes).limited, true);
    assert.ok(discovery(bytes).readBytes <= 1024 * 1024);
    assert.equal(discovery(bytes).visitedFiles, 5);
  });
});

test("oversized and malformed JS/TS declarations are omitted with incomplete discovery", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(join(root, "a-large.ts"), source + "//" + " ".repeat(256 * 1024));
    await writeFile(join(root, "b-invalid.ts"), "export function calculate(n: number { return n; }\n");
    const result = data(await references(workspace, "calculate"));
    assert.deepEqual(declarations(result).map(hit => hit.path), ["original.ts", "unrelated.ts"]);
    assert.equal(discovery(result).skippedFiles, 2);
    assert.equal(discovery(result).limited, true);
  });
});

test("unsupported languages and non-identifier queries preserve lexical fallback without false compiler candidates", async () => {
  await fixture(async (workspace, root) => {
    await writeFile(join(root, "sample.py"), "def calculate(n):\n    return n + 1\n");
    const unsupported = data(await references(workspace, "calculate", "sample.py"));
    assert.equal(unsupported.engine, "lexical_fallback");
    assert.deepEqual(declarations(unsupported), []);
    assert.equal(discovery(unsupported).visitedFiles, 0);
    const text = data(await references(workspace, "calculate n"));
    assert.deepEqual(declarations(text), []);
    assert.equal(discovery(text).status, "unsupported_query");
  });
});

test("declaration discovery detects concurrent changes before registering candidate aliases", async () => {
  await fixture(async (_workspace, root) => {
    const workspaceFiles = new WorkspaceFiles(root);
    const snapshot = await workspaceFiles.snapshot();
    const originalSnapshot = workspaceFiles.snapshot.bind(workspaceFiles);
    workspaceFiles.snapshot = async signal => {
      await writeFile(join(root, "original.ts"), source.replace("calculate", "renamed"));
      return originalSnapshot(signal);
    };
    const aliases = new LightAliasRegistry();
    const result = await new LightReferenceSearch(workspaceFiles, aliases).recovery(
      { query: "calculate", mode: "references" }, "symbol_target_required", snapshot.files,
      snapshot.revision.source_revision_id);
    assert.equal(result.declarationDiscovery?.status, "source_changed");
    assert.deepEqual(result.declarationCandidates, []);
    assert.equal(aliases.entries().length, 0);
  });
});

test("bare candidate discovery never authorizes an unread edit or refreshes stale body coverage", async () => {
  await fixture(async (workspace, root) => {
    const candidate = declarations(data(await references(workspace, "calculate", "original.ts")))[0]!;
    const edit = () => workspace.editCode({ operations: [{ kind: "symbol", target: candidate.alias,
      action: "replace_body", content: "{ return n * 2; }" }] });
    assert.equal((await edit()).status, "blocked");
    await workspace.readCode({ target: candidate.alias, view: "symbol" }, {});
    const changed = source.replace("n + 1", "n + 99");
    await writeFile(join(root, "original.ts"), changed);
    await references(workspace, "calculate", "original.ts");
    assert.equal((await edit()).status, "blocked");
    assert.equal(await readFile(join(root, "original.ts"), "utf8"), changed);
  });
});
