import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [baselinePath, candidatePath, outputPath] = process.argv.slice(2);
assert.ok(baselinePath && candidatePath && outputPath, 'Usage: replay.mjs BASELINE_HARNESS CANDIDATE_HARNESS NEW_OUTPUT');
const directories = { baseline: resolve(baselinePath), candidate: resolve(candidatePath) };
const output = resolve(outputPath);
await access(output).then(() => { throw Error('Refusing to overwrite evidence'); }, error => {
  if (error.code !== 'ENOENT') throw error;
});
const sha = value => createHash('sha256').update(value).digest('hex');
const boundFiles = ['light-reference-search.js', 'light-reference-candidates.js', 'light-workspace.js',
  'light-aliases.js', 'light-navigation.js', 'code-intelligence.js', 'semantic-reference-client.js'];
async function bindings(directory) {
  const result = {};
  for (const file of boundFiles) {
    try { result[file] = sha(await readFile(join(directory, file))); }
    catch (error) { if (error.code === 'ENOENT') result[file] = null; else throw error; }
  }
  return result;
}
const runtimeHashes = Object.fromEntries(await Promise.all(Object.entries(directories).map(async ([arm, directory]) =>
  [arm, await bindings(directory)])));
const fixtures = {
  saturation: {
    'a.ts': 'import { target } from "./z.js";\n' +
      Array.from({ length: 10 }, (_, i) => `export function caller${i}() { return target(${i}); }`).join('\n') + '\n',
    'unrelated.ts': 'export function target(n: number) { return n - 1; }\n',
    'z.ts': 'export function target(n: number) { return n + 1; }\n',
  },
  ambiguity: {
    'a.ts': 'export function target(n: number) { return n - 1; }\n',
    'consumer.ts': 'import { target as compute } from "./z.js";\nexport const value = compute(2);\n',
    'z.ts': 'export function target(n: number) { return n + 1; }\n',
  },
};
const common = {
  'package.json': '{"type":"module"}\n',
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022',
    module: 'NodeNext', moduleResolution: 'NodeNext', types: [] }, include: ['*.ts'] }) + '\n',
};
const parent = await mkdtemp(join(tmpdir(), 'blame-reference-candidates-'));
const records = [];
try {
  for (let repeat = 1; repeat <= 3; repeat++) {
    for (const [fixtureName, source] of Object.entries(fixtures)) {
      const input = { ...common, ...source };
      const fixtureHashes = Object.fromEntries(Object.entries(input).map(([path, value]) => [path, sha(value)]));
      const order = repeat % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const arm of order) {
        const root = join(parent, `${repeat}-${fixtureName}-${arm}`);
        await mkdir(root);
        for (const [path, value] of Object.entries(input)) await writeFile(join(root, path), value);
        const { LightWorkspace } = await import(pathToFileURL(join(directories[arm], 'light-workspace.js')));
        const workspace = new LightWorkspace(root, { sessionId: `reference-candidates-${repeat}-${fixtureName}-${arm}` });
        const calls = [];
        async function search(inputValue) {
          const started = performance.now();
          const result = await workspace.searchCode(inputValue);
          const milliseconds = performance.now() - started;
          assert.equal(result.status, 'ok', JSON.stringify(result));
          calls.push({ input: inputValue, milliseconds, serializedResultBytes: Buffer.byteLength(JSON.stringify(result)), result });
          return result.data;
        }
        const bare = await search({ query: 'target', mode: 'references' });
        assert.equal(bare.engine, 'lexical_fallback');
        assert.equal(bare.semanticFallback, 'symbol_target_required');
        assert.equal(bare.target, undefined);
        if (fixtureName === 'saturation') assert.equal(bare.results.some(hit => hit.path === 'z.ts'), false);
        let choices = bare.declarationCandidates ?? bare.results;
        if (!choices.some(hit => hit.path === 'z.ts' && hit.qualifiedName === 'target')) {
          assert.ok(bare.nextSearches.some(next => next.mode === 'symbol'));
          choices = (await search(bare.nextSearches.find(next => next.mode === 'symbol'))).results;
        }
        // Researcher selects the fixture's intended declaration. This is not observed model intent.
        const intended = choices.find(hit => hit.path === 'z.ts' && hit.qualifiedName === 'target');
        assert.ok(intended, 'Intended declaration must be present before choosing it');
        const resolved = await search({ query: intended.target ?? `${intended.path}#${intended.qualifiedName}`,
          mode: 'references' });
        assert.equal(resolved.engine, 'typescript_language_service');
        assert.equal(resolved.target, 'z.ts#target');
        assert.equal(resolved.navigationOnly, true);
        assert.ok(resolved.results.every(hit => hit.path !== 'unrelated.ts'));
        const afterHashes = {};
        for (const path of Object.keys(input)) afterHashes[path] = sha(await readFile(join(root, path)));
        assert.deepEqual(afterHashes, fixtureHashes);
        records.push({ repeat, fixture: fixtureName, arm, fixtureHashes, sourceUnchanged: true,
          choice: { actor: 'researcher', intended: 'z.ts#target', automaticHarnessSelection: false },
          calls, totalCalls: calls.length, totalMilliseconds: calls.reduce((n, call) => n + call.milliseconds, 0),
          totalSerializedResultBytes: calls.reduce((n, call) => n + call.serializedResultBytes, 0) });
        await rm(root, { recursive: true, force: true });
      }
    }
  }
  for (const [arm, directory] of Object.entries(directories)) assert.deepEqual(await bindings(directory), runtimeHashes[arm]);
  const summary = {};
  for (const arm of Object.keys(directories)) {
    const items = records.filter(record => record.arm === arm);
    summary[arm] = { executions: items.length, totalCalls: items.reduce((n, record) => n + record.totalCalls, 0),
      totalMilliseconds: items.reduce((n, record) => n + record.totalMilliseconds, 0),
      totalSerializedResultBytes: items.reduce((n, record) => n + record.totalSerializedResultBytes, 0) };
  }
  const evidence = { schemaVersion: 1, createdAt: new Date().toISOString(), kind: 'local_navigation_mechanism_replay',
    modelCalls: 0, researcherSelection: true, representativeBenchmark: false, runtimeHashes,
    scriptSha256: sha(await readFile(new URL(import.meta.url))), summary, records,
    limitations: ['Constructed known diagnostic, not new model confirmation.',
      'Three local repeats measure process/cache effects; they are not independent tasks.',
      'Serialized bytes are tool feedback sizes, not provider tokens.',
      'Wall time includes initial workspace setup and compiler worker startup; host scheduling is uncontrolled.',
      'Candidate discovery adds bounded work and larger initial feedback; fewer scripted calls do not prove agent efficiency.'] };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, summary, modelCalls: 0 }));
} finally { await rm(parent, { recursive: true, force: true }); }
