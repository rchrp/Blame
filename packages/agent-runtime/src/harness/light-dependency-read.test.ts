import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { LightWorkspace } from "./light-workspace.js";
import { sha256 } from "./light-identity.js";
import { CompilerServices, queryDependencyDeclaration, referenceFootprintIsCurrent } from "./semantic-reference-client.js";
import type { DependencyDeclarationReply } from "./semantic-reference-types.js";

const consumer = `// é🧪 lexical decoy: transform(string)
import DefaultApi, { transform as convert } from "sample-api";
import * as api from "sample-api";
export function use() { return convert(1); }
`;
const declaration = `/** Keep both overloads. */
export declare function transform(input: number): string;
export declare function transform(input: string): number;
export default class DefaultApi { readonly marker: "real-api"; }
export interface Options { enabled: boolean; }
`;
const config = { compilerOptions: { strict: true, noEmit: true, noLib: true,
  module: "NodeNext", moduleResolution: "NodeNext", types: [] }, include: ["*.ts", "*.js"] };

async function put(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
async function fixture(run: (root: string, workspace: LightWorkspace) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "light-dependency-"));
  try {
    await put(root, "package.json", '{"type":"module"}');
    await put(root, "tsconfig.json", JSON.stringify(config));
    await put(root, "consumer.ts", consumer);
    await put(root, "decoy.ts", 'export function transform(x: string) { return "decoy"; }');
    await put(root, "node_modules/sample-api/package.json", '{"name":"sample-api","version":"1.2.3","type":"module","types":"index.d.ts"}');
    await put(root, "node_modules/sample-api/index.d.ts", declaration);
    await run(root, new LightWorkspace(root, { sessionId: "dependency-types" }));
  } finally { await rm(root, { recursive: true, force: true }); }
}
const read = (workspace: LightWorkspace, name = "convert", offset?: number) =>
  workspace.readCode({ target: `consumer.ts#${name}`, view: "declaration", ...(offset !== undefined ? { offset } : {}) }, {});
function data(result: Awaited<ReturnType<typeof read>>) {
  assert.equal(result.status, "ok", JSON.stringify(result));
  return (result as { data: { content: string; readOnly: boolean; sources: Array<{ package: string; version: string; hash: string; packageHash: string; path: string }>;
    exports?: string[]; exportsTruncated?: boolean; nextRead?: { target: string; view: "declaration"; offset: number }; project: { warnings: string[] } } }).data;
}
async function query(root: string, name = "convert", timeoutMs?: number, signal?: AbortSignal) {
  return queryDependencyDeclaration({ root, declaration: true,
    target: { path: "consumer.ts", name, hash: sha256(await readFile(join(root, "consumer.ts"))) } }, signal, timeoutMs);
}

test("named alias resolves both overloads with package identity, excluding lexical decoys", async () => {
  await fixture(async (_root, workspace) => {
    const result = data(await read(workspace));
    assert.equal(result.readOnly, true);
    assert.match(result.content, /input: number.*\n[\s\S]*input: string/u);
    assert.doesNotMatch(result.content, /decoy|DefaultApi/u);
    assert.equal(result.sources.length, 2);
    for (const source of result.sources) {
      assert.equal(source.package, "sample-api"); assert.equal(source.version, "1.2.3");
      assert.equal(source.hash, sha256(Buffer.from(declaration)));
      assert.equal(source.path, "index.d.ts"); assert.match(source.packageHash, /^[a-f0-9]{64}$/u);
    }
    assert.ok(result.project.warnings.includes("declarations_describe_types_not_runtime_behavior"));
  });
});

test("namespace member and default imports select exact declarations", async () => {
  await fixture(async (_root, workspace) => {
    assert.match(data(await read(workspace, "api.Options")).content, /enabled: boolean/u);
    assert.match(data(await read(workspace, "api.Options.enabled")).content, /enabled: boolean/u);
    assert.match(data(await read(workspace, "DefaultApi")).content, /real-api/u);
    const root = data(await read(workspace, "api"));
    assert.deepEqual(root.exports, ["Options", "default", "transform"]);
    assert.equal(root.content, "");
    assert.equal(root.exportsTruncated, false);
  });
});

test("a local re-export follows compiler identity to the installed declaration", async () => {
  await fixture(async (root, workspace) => {
    await put(root, "barrel.ts", 'export { transform as wrapped } from "sample-api";');
    await put(root, "consumer.ts", 'import { wrapped as convert } from "./barrel.js";');
    assert.equal(data(await read(workspace)).sources[0]!.package, "sample-api");
  });
});

test("require imports, JS jsconfig and conditional exports use compiler resolution mode", async () => {
  await fixture(async (root, workspace) => {
    await put(root, "node_modules/sample-api/package.json", JSON.stringify({ name: "sample-api", version: "2.0.0",
      exports: { ".": { import: { types: "./esm.d.mts" }, require: { types: "./cjs.d.cts" } } } }));
    await put(root, "node_modules/sample-api/esm.d.mts", 'export declare const marker: "import-mode";');
    await put(root, "node_modules/sample-api/cjs.d.cts", 'export declare const marker: "require-mode";');
    await put(root, "consumer.ts", 'import * as api from "sample-api";');
    assert.match(data(await read(workspace, "api.marker")).content, /import-mode/u);
    await put(root, "consumer.cts", 'import api = require("sample-api");');
    await put(root, "tsconfig.json", JSON.stringify({ ...config, include: ["*.ts", "*.cts"] }));
    assert.match(data(await workspace.readCode({ target: "consumer.cts#api.marker", view: "declaration" }, {})).content, /require-mode/u);
    await rm(join(root, "tsconfig.json"));
    await put(root, "jsconfig.json", JSON.stringify({ ...config, compilerOptions: { ...config.compilerOptions, allowJs: true } }));
    await put(root, "javascript.js", 'import * as api from "sample-api";');
    assert.match(data(await workspace.readCode({ target: "javascript.js#api.marker", view: "declaration" }, {})).content, /import-mode/u);
  });
});

test("typesVersions resolves the installed compiler-specific declaration", async () => {
  await fixture(async (root, workspace) => {
    await put(root, "node_modules/sample-api/package.json", JSON.stringify({ name: "sample-api", version: "1.2.3", types: "index.d.ts",
      typesVersions: { ">=5.0": { "*": ["v5.d.ts"] } } }));
    await put(root, "node_modules/sample-api/v5.d.ts", 'export declare function transform(x: "version-five"): void;');
    assert.match(data(await read(workspace)).content, /version-five/u);
  });
});

test("Unicode pages are bounded and the supplied continuation reconstructs the complete declaration", async () => {
  await fixture(async (root, workspace) => {
    const text = `export interface Options {\n${Array.from({ length: 1300 }, (_, i) => `  é${i}: "🧪";`).join("\n")}\n}`;
    await put(root, "node_modules/sample-api/index.d.ts", text);
    let result = data(await read(workspace, "api.Options"));
    const pages: string[] = [];
    for (;;) {
      assert.ok(Buffer.byteLength(result.content) <= 12000);
      assert.doesNotMatch(result.content, /\uFFFD/u);
      pages.push(result.content);
      if (!result.nextRead) break;
      result = data(await workspace.readCode(result.nextRead, {}));
      assert.ok(pages.length < 10);
    }
    assert.equal(pages.join("").split("\n").slice(1).join("\n"), `${text}\n`);
    assert.ok(pages.length > 1);
    assert.equal((await read(workspace, "api.Options", 999999)).status, "blocked");
    const unicodeByte = Buffer.from(`// sample-api@1.2.3/index.d.ts:1\n${text}\n`).indexOf(Buffer.from("é"));
    assert.equal((await read(workspace, "api.Options", unicodeByte + 1)).status, "blocked");
  });
});

test("namespace export discovery is explicitly bounded", async () => {
  await fixture(async (root, workspace) => {
    await put(root, "node_modules/sample-api/index.d.ts", Array.from({ length: 80 }, (_, i) => `export declare const item${i}: number;`).join("\n"));
    const result = data(await read(workspace, "api"));
    assert.equal(result.exports!.length, 64); assert.equal(result.exportsTruncated, true);
    assert.match(data(await read(workspace, "api.item79")).content, /item79/u);
  });
});

test("declarations give neither dependency write access nor unseen consumer edit coverage", async () => {
  await fixture(async (root, workspace) => {
    await read(workspace);
    const result = await workspace.editCode({ operations: [{ kind: "symbol", target: "consumer.ts#use", action: "replace_body", content: "return 0;" }] });
    assert.equal(result.status, "blocked");
    assert.equal((await workspace.readCode({ target: "node_modules/sample-api/index.d.ts" }, {})).status, "blocked");
    const denied = await workspace.editCode({ operations: [{ kind: "patch", path: "node_modules/sample-api/index.d.ts", patch: "*** Begin Patch\n*** Update File: node_modules/sample-api/index.d.ts\n@@\n-export interface Options { enabled: boolean; }\n+export interface Options { enabled: string; }\n*** End Patch" }] });
    assert.notEqual(denied.status, "ok");
    assert.match(JSON.stringify(denied), /Dependency internals|runtime-managed/u);
    assert.equal(await readFile(join(root, "consumer.ts"), "utf8"), consumer);
    assert.equal(await readFile(join(root, "node_modules/sample-api/index.d.ts"), "utf8"), declaration);
    assert.equal((await workspace.readCode({ target: "@checks" }, {})).status, "ok");
  });
});

test("missing configuration, excluded source, unresolved/ambiguous imports and JavaScript-only dependencies stay explicit", async () => {
  await fixture(async (root, workspace) => {
    assert.match(JSON.stringify(await read(workspace, "use")), /import_binding_not_found/u);
    assert.match(JSON.stringify(await read(workspace, "api.absent")), /unresolved_import_declaration/u);
    await put(root, "consumer.ts", 'import { x as convert } from "absent";');
    assert.match(JSON.stringify(await read(workspace)), /unresolved_import_declaration/u);
    await put(root, "consumer.ts", 'import { transform as convert } from "sample-api";\nimport { transform as convert } from "sample-api";');
    assert.match(JSON.stringify(await read(workspace)), /ambiguous_import_binding/u);
    await put(root, "consumer.ts", consumer);
    await put(root, "tsconfig.json", JSON.stringify({ ...config, include: ["decoy.ts"] }));
    assert.match(JSON.stringify(await read(workspace)), /target_not_in_project/u);
    await rm(join(root, "tsconfig.json"));
    assert.match(JSON.stringify(await read(workspace)), /no_project_config/u);
    await put(root, "tsconfig.json", JSON.stringify(config));
    await rm(join(root, "node_modules/sample-api/index.d.ts"));
    await put(root, "node_modules/sample-api/index.js", "exports.transform = x => x;");
    assert.equal((await read(workspace)).status, "blocked");
  });
});

test("a kept service sees replacements and the original footprint rejects source/config/package/declaration changes", async () => {
  for (const [path, changed] of [
    ["consumer.ts", `${consumer}\n// changed`],
    ["tsconfig.json", JSON.stringify({ ...config, compilerOptions: { ...config.compilerOptions, strict: false } })],
    ["node_modules/sample-api/package.json", '{"name":"sample-api","version":"1.2.4","types":"index.d.ts"}'],
    ["node_modules/sample-api/index.d.ts", declaration.replace("input: number", "input: boolean")],
  ]) await fixture(async (root) => {
    const result = await query(root);
    assert.equal(result.status, "ok", JSON.stringify(result));
    if (result.status !== "ok") return;
    assert.equal(await referenceFootprintIsCurrent(result.footprint), true);
    await put(root, path!, changed!);
    assert.equal(await referenceFootprintIsCurrent(result.footprint), false, path);
    assert.equal((await query(root)).status, "ok");
  });
});

test("pnpm package links and a shared node_modules root work; link retargeting invalidates the footprint", async () => {
  await fixture(async (root, workspace) => {
    const store = "node_modules/.pnpm/sample-api@1.2.3/node_modules/sample-api";
    await put(root, `${store}/package.json`, '{"name":"sample-api","version":"1.2.3","types":"index.d.ts"}');
    await put(root, `${store}/index.d.ts`, declaration);
    await rm(join(root, "node_modules/sample-api"), { recursive: true });
    await symlink(join(root, store), join(root, "node_modules/sample-api"));
    assert.equal(data(await read(workspace)).sources[0]!.package, "sample-api");
    const first = await query(root); assert.equal(first.status, "ok");
    const other = "node_modules/.pnpm/sample-api@1.2.4/node_modules/sample-api";
    await put(root, `${other}/package.json`, '{"name":"sample-api","version":"1.2.4","types":"index.d.ts"}');
    await put(root, `${other}/index.d.ts`, declaration);
    await rm(join(root, "node_modules/sample-api"));
    await symlink(join(root, other), join(root, "node_modules/sample-api"));
    if (first.status === "ok") assert.equal(await referenceFootprintIsCurrent(first.footprint), false);
    assert.equal(data(await read(workspace)).sources[0]!.version, "1.2.4");
    await mkdir(join(root, ".blame/shared"), { recursive: true });
    const { rename } = await import("node:fs/promises");
    // Real package store remains under its canonical node_modules installation.
    await rename(join(root, "node_modules"), join(root, ".blame/shared/node_modules"));
    await rm(join(root, ".blame/shared/node_modules/sample-api"));
    await symlink(".pnpm/sample-api@1.2.4/node_modules/sample-api", join(root, ".blame/shared/node_modules/sample-api"));
    await symlink(join(root, ".blame/shared/node_modules"), join(root, "node_modules"));
    assert.equal(data(await read(workspace)).sources[0]!.version, "1.2.4");
  });
});

test("a kept service answers as a new one after dependencies are reinstalled or relinked", async () => {
  await fixture(async (root) => {
    const services = new CompilerServices();
    const answersAsNew = async () => {
      const fresh = new CompilerServices();
      try {
        const request = { root, declaration: true as const,
          target: { path: "consumer.ts", name: "convert", hash: sha256(await readFile(join(root, "consumer.ts"))) } };
        const kept = await services.query<DependencyDeclarationReply>(request, undefined, 8_000);
        const expected = await fresh.query<DependencyDeclarationReply>(request, undefined, 8_000);
        assert.equal(kept.status, "ok", JSON.stringify(kept));
        const { footprint, ...answer } = kept as Extract<DependencyDeclarationReply, { status: "ok" }>;
        assert.deepEqual({ ...expected, footprint }, kept);
        assert.equal(await referenceFootprintIsCurrent(footprint), true);
        return answer.declaration;
      } finally { await fresh.close(); }
    };
    try {
      assert.equal((await answersAsNew()).sources[0]!.version, "1.2.3");
      // Reinstalled: new metadata and declarations in place.
      await rm(join(root, "node_modules/sample-api"), { recursive: true });
      await put(root, "node_modules/sample-api/package.json", '{"name":"sample-api","version":"1.3.0","type":"module","types":"index.d.ts"}');
      await put(root, "node_modules/sample-api/index.d.ts", declaration.replace("input: number", "input: bigint"));
      let answer = await answersAsNew();
      assert.equal(answer.sources[0]!.version, "1.3.0");
      assert.match(answer.content, /input: bigint/u);
      // Relinked from a package store, as pnpm installs.
      for (const version of ["2.0.0", "2.1.0"]) {
        const store = `node_modules/.pnpm/sample-api@${version}/node_modules/sample-api`;
        await put(root, `${store}/package.json`, `{"name":"sample-api","version":"${version}","type":"module","types":"index.d.ts"}`);
        await put(root, `${store}/index.d.ts`, declaration.replace("input: number", `input: "${version}"`));
        await rm(join(root, "node_modules/sample-api"), { recursive: true });
        await symlink(join(root, store), join(root, "node_modules/sample-api"));
        answer = await answersAsNew();
        assert.equal(answer.sources[0]!.version, version);
        assert.match(answer.content, new RegExp(`input: "${version.replaceAll(".", "\\.")}"`, "u"));
      }
    } finally { await services.close(); }
  });
});

test("arbitrary package escapes, metadata mismatch and protected subpaths are refused", async () => {
  await fixture(async (root, workspace) => {
    await put(root, "outside/sample-api/package.json", '{"name":"sample-api","version":"1.0.0","types":"index.d.ts"}');
    await put(root, "outside/sample-api/index.d.ts", declaration);
    await rm(join(root, "node_modules/sample-api"), { recursive: true });
    await symlink(join(root, "outside/sample-api"), join(root, "node_modules/sample-api"));
    assert.match(JSON.stringify(await read(workspace)), /declaration_outside_installation/u);
    await rm(join(root, "node_modules/sample-api"));
    await put(root, "node_modules/sample-api/package.json", '{"name":"impostor","version":"1.0.0","types":"index.d.ts"}');
    await put(root, "node_modules/sample-api/index.d.ts", declaration);
    assert.match(JSON.stringify(await read(workspace)), /dependency_package_identity_mismatch/u);
    await put(root, "node_modules/sample-api/package.json", '{"name":"sample-api","version":"1.0.0","types":".ssh/secret.d.ts"}');
    await put(root, "node_modules/sample-api/.ssh/secret.d.ts", declaration);
    assert.match(JSON.stringify(await read(workspace)), /protected_declaration_path/u);
    await put(root, "node_modules/sample-api/package.json", '{"name":"sample-api","version":"1.0.0","types":".blame/secret.d.ts"}');
    await put(root, "node_modules/sample-api/.blame/secret.d.ts", declaration);
    assert.equal((await read(workspace)).status, "blocked");
  });
});

test("local augmentations are refused rather than misrepresented as installed-only declarations", async () => {
  await fixture(async (root, workspace) => {
    await put(root, "augmentation.ts", 'import "sample-api"; declare module "sample-api" { interface Options { local: boolean; } }');
    assert.equal((await read(workspace, "api.Options")).status, "blocked");
  });
});

test("a package metadata symlink cannot escape its canonical package", async () => {
  await fixture(async (root, workspace) => {
    await put(root, "other-metadata.json", '{"name":"sample-api","version":"9.0.0","types":"index.d.ts"}');
    await rm(join(root, "node_modules/sample-api/package.json"));
    await symlink(join(root, "other-metadata.json"), join(root, "node_modules/sample-api/package.json"));
    assert.match(JSON.stringify(await read(workspace)), /dependency_package_metadata_escape/u);
  });
});

test("worker timeout and cancellation terminate resolution; a stale source hash is rejected", async () => {
  await fixture(async (root) => {
    assert.deepEqual(await query(root, "convert", 0), { status: "unavailable", reason: "query_timeout" });
    await assert.rejects(query(root, "convert", undefined, AbortSignal.abort(new Error("cancel before"))), /cancel before/u);
    const controller = new AbortController();
    const pending = query(root, "convert", undefined, controller.signal);
    setTimeout(() => controller.abort(new Error("cancel during")), 5);
    await assert.rejects(pending, /cancel during/u);
    const result = await queryDependencyDeclaration({ root, declaration: true, target: { path: "consumer.ts", name: "convert", hash: "stale" } });
    assert.deepEqual(result, { status: "unavailable", reason: "source_changed" });
  });
});

test("project and projection budgets fail explicitly", async () => {
  await fixture(async (root, workspace) => {
    for (let index = 0; index < 2001; index++) await put(root, `extra${index}.ts`, "");
    assert.match(JSON.stringify(await read(workspace)), /project_file_budget_exceeded/u);
  });
  await fixture(async (root, workspace) => {
    await put(root, "node_modules/sample-api/index.d.ts", `export interface Options { field: "${"x".repeat(256001)}" }`);
    assert.match(JSON.stringify(await read(workspace, "api.Options")), /declaration_byte_budget_exceeded/u);
  });
  await fixture(async (root, workspace) => {
    await put(root, "node_modules/sample-api/index.d.ts", Array.from({ length: 17 }, (_, index) =>
      `export declare function transform(input: ${index}): void;`).join("\n"));
    assert.match(JSON.stringify(await read(workspace)), /declaration_count_budget_exceeded/u);
  });
  await fixture(async (root) => {
    await put(root, "node_modules/sample-api/index.d.ts", `/*${"x".repeat(64 * 1024 * 1024)}*/`);
    const result = await query(root);
    assert.deepEqual(result, { status: "unavailable", reason: "project_read_budget_exceeded" });
  });
});
