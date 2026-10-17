#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'packages/agent-runtime/package.json'));
const ts = require('typescript');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const engineFiles = ['symbolic-analysis', 'symbolic-expression', 'symbolic-program', 'symbolic-solver', 'symbolic-types'];
const [mode, outputArgument, runtimeArgument] = process.argv.slice(2);
if (!['prepare', 'run'].includes(mode) || !outputArgument || !isAbsolute(outputArgument))
  throw new Error('Usage: node local.mjs prepare|run /absolute/output [/absolute/compiled/harness]');
const output = resolve(outputArgument);

function corpus() {
  const seed = 0x49b1a6e3;
  let state = seed;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const coefficient = 1 + next() % 3, offset = next() % 7 - 3, threshold = 2 + next() % 5;
  const integer = { min: -4, max: 4 }, flag = { type: 'boolean' };
  const input = { x: integer };
  const choose = (body) => `function choose(x: number) { ${body} }`;
  const cases = [
    { id: 'generated-affine-valid', source: choose(`return x * ${coefficient} + ${offset};`), inputs: input, assertion: `result === x * ${coefficient} + ${offset}` },
    { id: 'generated-affine-bug', source: choose(`return x * ${coefficient + 1} + ${offset};`), inputs: input, assertion: `result === x * ${coefficient} + ${offset}` },
    { id: 'clamp-valid', source: 'function choose(x: number, lo: number, hi: number) { if (x < lo) return lo; if (x > hi) return hi; return x; }', inputs: { x: integer, lo: { min: -2, max: 2 }, hi: { min: -2, max: 2 } }, assertion: 'lo > hi || (result >= lo && result <= hi)' },
    { id: 'clamp-low-branch-bug', source: 'function choose(x: number, lo: number, hi: number) { if (x < lo) return x; if (x > hi) return hi; return x; }', inputs: { x: integer, lo: { min: -2, max: 2 }, hi: { min: -2, max: 2 } }, assertion: 'lo > hi || (result >= lo && result <= hi)' },
    { id: 'absolute-valid', source: choose('if (x < 0) return -x; return x;'), inputs: input, assertion: 'result >= 0 && result * result === x * x' },
    { id: 'absolute-negative-bug', source: choose('if (x < 0) return x; return x;'), inputs: input, assertion: 'result >= 0 && result * result === x * x' },
    { id: 'conditional-arrow-valid', source: `const choose = (x: number, enabled: boolean): number => enabled ? x + ${coefficient} : x - ${coefficient};`, inputs: { x: integer, enabled: flag }, assertion: `result === (enabled ? x + ${coefficient} : x - ${coefficient})` },
    { id: 'conditional-arrow-bug', source: `const choose = (x: number, enabled: boolean): number => enabled ? x + ${coefficient} : x + ${coefficient};`, inputs: { x: integer, enabled: flag }, assertion: `result === (enabled ? x + ${coefficient} : x - ${coefficient})` },
    { id: 'nonlinear-local-valid', source: choose(`const square = x * x; if (square > ${threshold}) { const negative = -square; return negative; } return square + 1;`), inputs: input, assertion: `result === (x * x > ${threshold} ? -(x * x) : x * x + 1)` },
    { id: 'nonlinear-local-bug', source: choose(`const square = x * x; if (square > ${threshold}) { const negative = -square; return negative; } return square - 1;`), inputs: input, assertion: `result === (x * x > ${threshold} ? -(x * x) : x * x + 1)` },
    { id: 'boolean-equivalence-valid', source: 'function choose(x: number, y: number): boolean { return !(x !== y); }', inputs: { x: integer, y: integer }, assertion: 'result === (x === y)' },
    { id: 'boolean-equivalence-bug', source: 'function choose(x: number, y: number): boolean { return x !== y; }', inputs: { x: integer, y: integer }, assertion: 'result === (x === y)' },
    { id: 'two-return-block-valid', source: 'function choose(x: number, y: number) { if (x <= y) { return x; } else { return y; } }', inputs: { x: integer, y: integer }, assertion: 'result <= x && result <= y && (result === x || result === y)' },
    { id: 'two-return-block-bug', source: 'function choose(x: number, y: number) { if (x <= y) { return y; } else { return x; } }', inputs: { x: integer, y: integer }, assertion: 'result <= x && result <= y && (result === x || result === y)' },
    { id: 'safe-upper-boundary', source: choose('return x - 1;'), inputs: { x: { min: Number.MAX_SAFE_INTEGER - 4, max: Number.MAX_SAFE_INTEGER } }, assertion: 'result < x' },
    { id: 'safe-lower-boundary', source: choose('return x + 1;'), inputs: { x: { min: Number.MIN_SAFE_INTEGER, max: Number.MIN_SAFE_INTEGER + 4 } }, assertion: 'result > x' },
    { id: 'boolean-short-circuit-valid', source: 'const choose = (x: number, enabled: boolean): boolean => enabled && x < 0;', inputs: { x: integer, enabled: flag }, assertion: 'result === (enabled && x < 0)' },
    { id: 'boolean-short-circuit-bug', source: 'const choose = (x: number, enabled: boolean): boolean => enabled || x < 0;', inputs: { x: integer, enabled: flag }, assertion: 'result === (enabled && x < 0)' },
  ].map((entry) => ({ ...entry, functionName: 'choose', sourceSha256: hash(entry.source), expectedMode: 'supported' }));
  const controls = [
    { id: 'unsupported-call', source: choose('return Math.abs(x);'), inputs: input, assertion: 'result >= 0', expectedReason: 'unsupported_expression' },
    { id: 'unsupported-loop', source: choose('while (x < 0) { x++; } return x;'), inputs: input, assertion: 'result >= 0', expectedReason: 'unsupported_statement' },
    { id: 'unsupported-fraction', source: choose('return x + 0.5;'), inputs: input, assertion: 'result > x', expectedReason: 'non_safe_integer_literal' },
    { id: 'unsupported-overflow', source: choose('return x + 1;'), inputs: { x: { min: Number.MAX_SAFE_INTEGER - 1, max: Number.MAX_SAFE_INTEGER } }, assertion: 'result > x', expectedReason: 'unsafe_integer_intermediate' },
    { id: 'unsupported-infinite-contract', source: choose('return x;'), inputs: { x: { min: 0, max: 'Infinity' } }, assertion: 'result >= 0', expectedReason: 'finite_safe_integer_bounds_required', decodeInfinity: true },
    { id: 'unsupported-global', source: choose('return x + offset;'), inputs: input, assertion: 'result > x', expectedReason: 'unbound_identifier' },
    { id: 'unsupported-source-syntax', source: 'function choose(x: number) { return ; ; broken @@@ }', inputs: input, assertion: 'result >= 0', expectedReason: 'source_parse_error' },
    { id: 'unsupported-property-injection', source: choose('return x;'), inputs: input, assertion: 'true), rogue = (false', expectedReason: 'assertion_expression_required' },
  ].map((entry) => ({ ...entry, functionName: 'choose', sourceSha256: hash(entry.source), expectedMode: 'unsupported' }));
  return { seed, generator: 'xorshift32; generated affine coefficients, offsets, nonlinear threshold; fixed structural families', coefficient, offset, threshold, cases: [...cases, ...controls] };
}

if (mode === 'prepare') {
  if (existsSync(output)) throw new Error('Refusing existing local preparation directory');
  await mkdir(output, { recursive: true });
  const specification = { phase: 'F49-local', preparedAt: new Date().toISOString(), sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    purpose: 'Mechanism diagnostic only: compare selected isolated scalar body semantics against actual JS exhaustive bounded enumeration. No model calls, task success or repository-wide proof.',
    comparison: 'For every supported finite-domain fixture, enumerate all supplied inputs before reading solver results; compare existence of property violation to Z3 status. Re-execute every solver witness in actual transpiled JS. Preserve unknown results and discrepancies.',
    timing: 'Single sequential researcher-host measurements, no randomized performance trial. Enumeration includes one transpilation, VM context and property script creation per case, then bounded execution of every input. Solver duration includes production translation, version process and solve process. VM timing is not native unit-test performance.',
    retention: 'Every supported case must agree and every witness must execute in real JS; unsupported controls must be unknown with the expected refusal. Local success permits opt-in integration study, establishes no model quality or token gain.',
    scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))), ...corpus() };
  await writeFile(join(output, 'corpus.json'), json(specification), { flag: 'wx' });
  console.log(json({ phase: specification.phase, prepared: specification.cases.length, seed: specification.seed, corpusSha256: hash(json(specification)) }));
  process.exit(0);
}

const corpusBytes = await readFile(join(output, 'corpus.json'));
const specification = JSON.parse(corpusBytes);
if (hash(readFileSync(fileURLToPath(import.meta.url))) !== specification.scriptSha256) throw new Error('Script changed after preparation');
if (existsSync(join(output, 'results.json'))) throw new Error('Refusing existing results');
const runtime = runtimeArgument ? resolve(runtimeArgument) : join(root, 'packages/agent-runtime/dist/harness');
if (runtimeArgument && !isAbsolute(runtimeArgument)) throw new Error('Runtime must be absolute');
const { analyzeSymbolicSource } = await import(pathToFileURL(join(runtime, 'symbolic-analysis.js')).href);
const hashes = Object.fromEntries(engineFiles.map((name) => [name, { compiled: hash(readFileSync(join(runtime, `${name}.js`))), source: hash(readFileSync(join(root, 'packages/agent-runtime/src/harness', `${name}.ts`))) }]));
const configuredSolver = process.env.BLAME_Z3_PATH ?? 'z3';
const located = configuredSolver.includes('/') ? configuredSolver : spawnSync('which', [configuredSolver], { encoding: 'utf8' }).stdout.trim();
if (!located || !existsSync(located)) throw new Error('Pinned solver executable required');
const executable = realpathSync(located);
const solver = { executable, binarySha256: hash(readFileSync(executable)), version: spawnSync(executable, ['-version'], { encoding: 'utf8', timeout: 1000 }).stdout.trim() };
if (!/^Z3 version /.test(solver.version)) throw new Error('Solver identity unavailable');
const observations = [];
const failures = [];
const allInputs = (contracts) => {
  let entries = [{}];
  for (const [name, contract] of Object.entries(contracts)) {
    const values = contract.type === 'boolean' ? [false, true] : Array.from({ length: contract.max - contract.min + 1 }, (_, index) => contract.min + index);
    entries = entries.flatMap((entry) => values.map((value) => ({ ...entry, [name]: value })));
  }
  return entries;
};
for (const entry of specification.cases) {
  if (hash(entry.source) !== entry.sourceSha256) throw new Error('Recorded source changed');
  const inputs = structuredClone(entry.inputs);
  if (entry.decodeInfinity) inputs.x.max = Infinity;
  let enumeration, execute;
  if (entry.expectedMode === 'supported') {
    const started = performance.now();
    const emitted = ts.transpileModule(entry.source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    new vm.Script(emitted).runInContext(context, { timeout: 100 });
    const names = Object.keys(inputs);
    const script = new vm.Script(`__result = choose(${names.map((name) => `__inputs[${JSON.stringify(name)}]`).join(',')});\n__property = ((${names.join(',')}, result) => (${entry.assertion}))(${names.map((name) => `__inputs[${JSON.stringify(name)}]`).join(',')}, __result);`);
    execute = (values) => {
      context.__inputs = values;
      script.runInContext(context, { timeout: 100 });
      return { result: context.__result, property: context.__property };
    };
    const entries = allInputs(inputs);
    const counterexamples = [];
    for (const values of entries) {
      const actual = execute(values);
      if (typeof actual.property !== 'boolean' || !['number', 'boolean'].includes(typeof actual.result)) throw new Error('Unexpected fixture result');
      if (!actual.property) counterexamples.push({ inputs: values, result: actual.result });
    }
    enumeration = { executedInputs: entries.length, violations: counterexamples.length, firstCounterexample: counterexamples[0] ?? null, durationMs: performance.now() - started };
  }
  const started = performance.now();
  const result = await analyzeSymbolicSource({ source: entry.source, functionName: entry.functionName, inputs, assertion: entry.assertion, solverPath: executable, timeoutMs: 2500 });
  const solverDurationMs = performance.now() - started;
  let agrees = false, realJsWitness = null;
  if (enumeration) {
    agrees = result.status === (enumeration.violations ? 'counterexample' : 'bounded_no_counterexample');
    if (result.witness) {
      const actual = execute(result.witness.inputs);
      realJsWitness = { result: actual.result, property: actual.property, matchesReportedResult: actual.result === result.witness.result, violatesProperty: actual.property === false };
      agrees &&= realJsWitness.matchesReportedResult && realJsWitness.violatesProperty;
    }
  } else agrees = result.status === 'unknown' && result.reason.includes(entry.expectedReason) && !result.solver;
  if (!agrees || result.validationAdmission !== false || result.sourceSha256 !== entry.sourceSha256) failures.push(entry.id);
  observations.push({ id: entry.id, expectedMode: entry.expectedMode, enumeration: enumeration ?? null, result, solverDurationMs, realJsWitness, agrees });
}
for (const name of engineFiles)
  if (hash(readFileSync(join(runtime, `${name}.js`))) !== hashes[name].compiled || hash(readFileSync(join(root, 'packages/agent-runtime/src/harness', `${name}.ts`))) !== hashes[name].source)
    throw new Error('Engine changed during local run');
if (hash(readFileSync(executable)) !== solver.binarySha256) throw new Error('Solver changed during local run');
const supported = observations.filter((entry) => entry.enumeration);
const results = { phase: specification.phase, completedAt: new Date().toISOString(), corpusSha256: hash(corpusBytes), scriptSha256: specification.scriptSha256,
  runtime, hashes, solver, environment: { platform: process.platform, arch: process.arch, node: process.version, typescript: ts.version },
  summary: { cases: observations.length, supported: supported.length, unsupported: observations.length - supported.length,
    exhaustiveInputs: supported.reduce((sum, entry) => sum + entry.enumeration.executedInputs, 0),
    counterexamples: supported.filter((entry) => entry.result.status === 'counterexample').length,
    boundedNoCounterexample: supported.filter((entry) => entry.result.status === 'bounded_no_counterexample').length,
    unknownSupported: supported.filter((entry) => entry.result.status === 'unknown').length,
    unsupportedRefusals: observations.filter((entry) => !entry.enumeration && entry.agrees).length,
    enumerationDurationMs: supported.reduce((sum, entry) => sum + entry.enumeration.durationMs, 0), solverDurationMs: supported.reduce((sum, entry) => sum + entry.solverDurationMs, 0),
    failures, modelCalls: 0, validationAdmission: false, conclusion: failures.length ? 'Discrepancies retained; investigate before use.' : 'Local bounded mechanism agrees on this selected diagnostic corpus; no model quality, efficiency or broad semantic completeness claim.' }, observations };
await writeFile(join(output, 'results.json'), json(results), { flag: 'wx' });
console.log(json(results.summary));
if (failures.length) process.exitCode = 1;
