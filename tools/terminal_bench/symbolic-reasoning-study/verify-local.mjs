#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'packages/agent-runtime/package.json'));
const ts = require('typescript');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const directory = process.argv[2];
if (!directory || !isAbsolute(directory)) throw new Error('Usage: node verify-local.mjs /absolute/local-output');
const corpusBytes = await readFile(join(directory, 'corpus.json'));
const resultsBytes = await readFile(join(directory, 'results.json'));
const corpus = JSON.parse(corpusBytes), results = JSON.parse(resultsBytes);
assert.equal(results.corpusSha256, hash(corpusBytes));
assert.equal(results.scriptSha256, corpus.scriptSha256);
assert.equal(hash(await readFile(join(root, 'tools/terminal_bench/symbolic-reasoning-study/local.mjs'))), corpus.scriptSha256);
assert.equal(results.environment.typescript, ts.version);
assert.equal(results.observations.length, corpus.cases.length);
assert.equal(new Set(results.observations.map((entry) => entry.id)).size, corpus.cases.length);
const discrepancies = [], replayedWitnesses = [];
let enumeratedInputs = 0, supported = 0, refused = 0;
for (const entry of corpus.cases) {
  assert.equal(hash(entry.source), entry.sourceSha256);
  const observation = results.observations.find((value) => value.id === entry.id);
  assert.ok(observation, `Missing ${entry.id}`);
  const result = observation.result;
  assert.equal(result.sourceSha256, entry.sourceSha256);
  assert.equal(result.validationAdmission, false);
  if (entry.expectedMode === 'unsupported') {
    const matches = result.status === 'unknown' && result.reason.includes(entry.expectedReason) && !result.solver;
    if (matches) refused++; else discrepancies.push(entry.id);
    assert.equal(observation.agrees, matches);
    continue;
  }
  supported++;
  const compiled = ts.transpileModule(entry.source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(compiled).runInContext(context, { timeout: 100 });
  const names = Object.keys(entry.inputs);
  const run = new vm.Script(`observed = choose(${names.map((name) => `input[${JSON.stringify(name)}]`).join(',')}); satisfied = ((${names.join(',')}, result) => (${entry.assertion}))(${names.map((name) => `input[${JSON.stringify(name)}]`).join(',')}, observed);`);
  const execute = (inputs) => {
    context.input = inputs;
    run.runInContext(context, { timeout: 100 });
    return { result: context.observed, property: context.satisfied };
  };
  let all = [{}];
  for (const [name, bound] of Object.entries(entry.inputs)) {
    const values = bound.type === 'boolean' ? [false, true] : Array.from({ length: bound.max - bound.min + 1 }, (_, index) => bound.min + index);
    all = all.flatMap((inputs) => values.map((value) => ({ ...inputs, [name]: value })));
  }
  const violations = all.map((inputs) => ({ inputs, actual: execute(inputs) })).filter((value) => value.actual.property === false);
  enumeratedInputs += all.length;
  assert.equal(observation.enumeration.executedInputs, all.length);
  assert.equal(observation.enumeration.violations, violations.length);
  let agrees = result.status === (violations.length ? 'counterexample' : 'bounded_no_counterexample');
  if (result.witness) {
    const actual = execute(result.witness.inputs);
    const admitted = actual.property === false && actual.result === result.witness.result;
    agrees &&= admitted;
    replayedWitnesses.push({ id: entry.id, ...actual, matchesReportedResult: actual.result === result.witness.result, admitted });
    assert.equal(result.witness.concretelyReproduced, true);
    assert.equal(result.witness.assertion, false);
  }
  if (!agrees) discrepancies.push(entry.id);
  assert.equal(observation.agrees, agrees);
}
assert.equal(results.summary.exhaustiveInputs, enumeratedInputs);
assert.equal(results.summary.supported, supported);
assert.equal(results.summary.unsupportedRefusals, refused);
assert.deepEqual(results.summary.failures, discrepancies);
assert.equal(results.summary.modelCalls, 0);
const verification = { phase: 'F49-local', corpusSha256: hash(corpusBytes), resultsSha256: hash(resultsBytes), verifierSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  exhaustiveInputsReplayed: enumeratedInputs, supportedCases: supported, unsupportedRefusals: refused,
  witnessesReplayed: replayedWitnesses.length, replayedWitnesses, discrepancies,
  verification: discrepancies.length ? 'discrepancies_preserved' : 'all_recorded_semantic_classifications_reproduced', modelCalls: 0,
  scope: 'Replays only recorded generated isolated scalar functions in actual transpiled JavaScript; does not rerun Z3, prove translator completeness, audit arbitrary project behavior or establish task success.' };
await writeFile(join(directory, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ ...verification, replayedWitnesses: undefined }, null, 2));
if (discrepancies.length) process.exitCode = 1;
