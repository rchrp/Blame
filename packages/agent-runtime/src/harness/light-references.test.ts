import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LightWorkspace } from "./light-workspace.js";
import { LightAliasRegistry } from "./light-aliases.js";
import { LightReferenceSearch } from "./light-reference-search.js";
import { sha256 } from "./light-identity.js";
import { WorkspaceFiles } from "./workspace-files.js";
import {
  CompilerServices,
  querySemanticReferences,
  referenceFootprintIsCurrent,
} from "./semantic-reference-client.js";
import type {
  SemanticReferenceReply,
  SemanticReferenceRequest,
} from "./semantic-reference-types.js";

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
      ts.version,
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

test("a kept compiler service sees added references and changed project configuration", async () => {
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

type ReferenceAnswer = Extract<SemanticReferenceReply, { status: "ok" }>;

async function compilerFixture(
  sources: Record<string, string>,
  run: (root: string, services: CompilerServices) => Promise<void>,
) {
  // Without the /var symlink of macOS: resolution through node_modules reports canonical paths.
  const root = await realpath(await mkdtemp(join(tmpdir(), "light-compiler-service-")));
  const services = new CompilerServices();
  try {
    for (const [path, text] of Object.entries(sources)) await put(root, path, text);
    await run(root, services);
  } finally {
    await services.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function put(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
// The first declaration named `name` in the file.
async function target(root: string, path: string, name: string): Promise<SemanticReferenceRequest> {
  const content = await readFile(join(root, path));
  return { root, target: { path, name, start: 0, end: content.byteLength, hash: sha256(content) } };
}
// A kept service's answer is the one a new service gives. Its footprint also
// keeps what earlier requests read, all of it still current.
async function answersAsNew(services: CompilerServices, request: SemanticReferenceRequest) {
  const fresh = new CompilerServices();
  try {
    const kept = await services.query<SemanticReferenceReply>(request, undefined, 8_000);
    const expected = await fresh.query<SemanticReferenceReply>(request, undefined, 8_000);
    assert.equal(kept.status, "ok", JSON.stringify(kept));
    assert.equal(expected.status, "ok", JSON.stringify(expected));
    const { footprint, ...answer } = kept as ReferenceAnswer;
    const { footprint: freshFootprint, ...freshAnswer } = expected as ReferenceAnswer;
    assert.deepEqual(answer, freshAnswer);
    const keys = (entries: object[]) => new Set(entries.map((entry) => JSON.stringify(entry)));
    const reads = keys(footprint.reads), existence = keys(footprint.existence);
    for (const entry of freshFootprint.reads) assert.ok(reads.has(JSON.stringify(entry)), entry.path);
    for (const entry of freshFootprint.existence) assert.ok(existence.has(JSON.stringify(entry)), entry.path);
    assert.equal(await referenceFootprintIsCurrent(footprint), true);
    return { answer, footprint };
  } finally {
    await fresh.close();
  }
}
const referencePaths = (answer: { locations: Array<{ path: string }> }) =>
  [...new Set(answer.locations.map((location) => location.path))].sort();

test("a kept compiler service answers as a new one after edits, added and deleted files, a branch switch and a configuration change", async () => {
  const project = { compilerOptions: { ...config.compilerOptions }, include: ["**/*.ts"] };
  await compilerFixture({
    "package.json": '{"type":"module"}',
    "tsconfig.json": JSON.stringify(project),
    "original.ts": source,
    "consumer.ts": 'import { calculate } from "./original.js";\nexport const use = () => calculate(1);\n',
    "probe/marker.ts": "export const marker = 1;\n",
  }, async (root, services) => {
    // A request in probe/ looks for probe/tsconfig.json; a project rebuilt
    // since then no longer holds that lookup.
    const marker = join(root, "probe/tsconfig.json");
    const plant = async () => assert.equal(
      (await services.query<SemanticReferenceReply>(await target(root, "probe/marker.ts", "marker"), undefined, 8_000)).status, "ok");
    const kept = (footprint: ReferenceAnswer["footprint"]) => footprint.existence.some(({ path }) => path === marker);
    const calculate = () => target(root, "original.ts", "calculate");
    await plant();
    let result = await answersAsNew(services, await calculate());
    assert.deepEqual(referencePaths(result.answer), ["consumer.ts"]);
    assert.equal(kept(result.footprint), true);

    // A rename plan checks its edits in memory only.
    const renamed = await services.query<SemanticReferenceReply>(
      { ...(await calculate()), renameTo: "compute" }, undefined, 12_000);
    assert.equal(renamed.status, "ok", JSON.stringify(renamed));
    result = await answersAsNew(services, await calculate());
    assert.equal(kept(result.footprint), true);

    // Edited sources are reparsed in the kept project.
    await put(root, "consumer.ts", 'import { calculate } from "./original.js";\nexport const use = () => calculate(1) + calculate(2);\n');
    await put(root, "original.ts", `// moved\n${source}export const again = calculate(3);\n`);
    result = await answersAsNew(services, await calculate());
    assert.equal(result.answer.locations.length, 4);
    assert.equal(kept(result.footprint), true);

    // A new file joins the project's roots.
    await put(root, "extra.ts", 'import { calculate as c } from "./original.js";\nc(4);\n');
    result = await answersAsNew(services, await calculate());
    assert.deepEqual(referencePaths(result.answer), ["consumer.ts", "extra.ts", "original.ts"]);
    assert.equal(kept(result.footprint), true);

    // A file the project read disappears: rebuilt.
    await rm(join(root, "consumer.ts"));
    result = await answersAsNew(services, await calculate());
    assert.deepEqual(referencePaths(result.answer), ["extra.ts", "original.ts"]);
    assert.equal(kept(result.footprint), false);

    // A branch switch changes, adds and deletes files at once.
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "main");
    git("checkout", "-qb", "feature");
    await rm(join(root, "extra.ts"));
    await put(root, "original.ts", `${source}export const twice = (n: number) => calculate(calculate(n));\n`);
    await put(root, "caller.ts", 'import { calculate } from "./original.js";\ncalculate(5);\n');
    git("add", "-A");
    git("commit", "-qm", "feature");
    git("checkout", "-q", "main");
    await plant();
    result = await answersAsNew(services, await calculate());
    assert.deepEqual(referencePaths(result.answer), ["extra.ts", "original.ts"]);
    git("checkout", "-q", "feature");
    result = await answersAsNew(services, await calculate());
    assert.deepEqual(referencePaths(result.answer), ["caller.ts", "original.ts"]);
    assert.equal(result.answer.locations.length, 4);

    // A changed configuration rebuilds the project.
    await plant();
    await put(root, "tsconfig.json", JSON.stringify({ ...project, include: ["original.ts"] }));
    result = await answersAsNew(services, await calculate());
    assert.deepEqual(referencePaths(result.answer), ["original.ts"]);
    assert.equal(kept(result.footprint), false);
  });
});

test("a file or an installed package that takes over an import resolution rebuilds the kept project", async () => {
  await compilerFixture({
    "package.json": '{"type":"module"}',
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "Bundler", types: [] },
      include: ["**/*.ts"],
    }),
    "original.ts": source,
    "calc/index.ts": 'export { calculate } from "../original";\n',
    "consumer.ts": 'import { calculate } from "./calc";\nexport const use = () => calculate(1);\n',
    "node_modules/pkg/package.json": '{"name":"pkg","version":"1.0.0","types":"index.d.ts"}',
    "node_modules/pkg/index.d.ts": "export declare function convert(n: number): number;\n",
    "top.ts": 'import { convert } from "pkg";\nexport const one = convert(1);\n',
    "sub/user.ts": 'import { convert } from "pkg";\nexport const two = convert(2);\n',
    "sub/late.ts": 'import { later } from "late-pkg";\nexport const three = later;\n',
  }, async (root, services) => {
    const calculate = () => target(root, "original.ts", "calculate");
    let result = await answersAsNew(services, await calculate());
    assert.deepEqual(referencePaths(result.answer), ["calc/index.ts", "consumer.ts"]);
    assert.ok(result.answer.project.warnings.includes("unresolved_imports"));
    // ./calc now names calc.ts before calc/index.ts.
    await put(root, "calc.ts", "export function calculate(n: number) { return n; }\n");
    result = await answersAsNew(services, await calculate());
    assert.deepEqual(referencePaths(result.answer), ["calc/index.ts"]);

    const convert = () => target(root, "node_modules/pkg/index.d.ts", "convert");
    result = await answersAsNew(services, await convert());
    assert.deepEqual(referencePaths(result.answer), ["sub/user.ts", "top.ts"]);
    // A nearer installation serves sub/, and the missing package arrives there.
    await put(root, "sub/node_modules/pkg/package.json", '{"name":"pkg","version":"2.0.0","types":"index.d.ts"}');
    await put(root, "sub/node_modules/pkg/index.d.ts", "export declare function convert(n: number): number;\n");
    await put(root, "sub/node_modules/late-pkg/package.json", '{"name":"late-pkg","version":"1.0.0","types":"index.d.ts"}');
    await put(root, "sub/node_modules/late-pkg/index.d.ts", "export declare const later: number;\n");
    result = await answersAsNew(services, await convert());
    assert.deepEqual(referencePaths(result.answer), ["top.ts"]);
    assert.ok(!result.answer.project.warnings.includes("unresolved_imports"));
  });
});

test("compiler services take turns per root, keep at most their limit and stop when idle", async () => {
  const sources = { "package.json": '{"type":"module"}', "tsconfig.json": JSON.stringify(config), "original.ts": source,
    "consumer.ts": files["consumer.ts"] };
  await compilerFixture(sources, async (first) => {
    await compilerFixture(sources, async (second) => {
      const services = new CompilerServices({ idleMs: 100, limit: 1 });
      try {
        const request = await target(first, "original.ts", "calculate");
        // A request stopped while its worker starts leaves the next ones a working service.
        assert.deepEqual(await services.query(request, undefined, 1), { status: "unavailable", reason: "query_timeout" });
        const replies = await Promise.all([1, 2, 3].map(() =>
          services.query<SemanticReferenceReply>(request, undefined, 8_000)));
        assert.deepEqual(replies.map(({ status }) => status), ["ok", "ok", "ok"]);
        assert.deepEqual(services.roots, [first]);
        // Another root takes the place of the least recently used.
        const other = await target(second, "original.ts", "calculate");
        assert.equal((await services.query<SemanticReferenceReply>(other, undefined, 8_000)).status, "ok");
        assert.deepEqual(services.roots, [second]);
        await new Promise((done) => setTimeout(done, 400));
        assert.deepEqual(services.roots, []);
        assert.equal((await services.query<SemanticReferenceReply>(other, undefined, 8_000)).status, "ok");
      } finally {
        await services.close();
      }
    });
  });
});

type DeclarationCandidate = { alias: string; target: string; path: string; qualifiedName: string; signature: string };
const declarations = (value: Record<string, unknown>) => value.declarationCandidates as DeclarationCandidate[];
const discovery = (value: Record<string, unknown>) => value.declarationDiscovery as {
  status: string; limited: boolean; visitedFiles: number; readBytes: number; skippedFiles: number;
};

test("bare references discover exact declarations beyond saturated lexical callers without choosing one", async () => {
  await fixture(async (workspace, root) => {
    // Callers in many files fill the first lexical page even though each file shows only its best lines.
    for (let index = 0; index < 10; index += 1)
      await writeFile(join(root, `a${index}.ts`), 'import { calculate } from "./original.js";\n' +
        `export function caller${index}() { return calculate(${index}); }\n`);
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
