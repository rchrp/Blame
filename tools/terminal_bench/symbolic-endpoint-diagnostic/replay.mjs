// Post-hoc diagnostic only: no model requests, source repair or new agent successes.
// Run only after every F50 worker has stopped and the original endpoints are published.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, appendFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { prepare, repo, work, study, dependencyRoot } from '../symbolic-reasoning-model-study/setup.mjs';
import { solverIdentity } from '../symbolic-reasoning-model-study/solver-identity.mjs';

const args = process.argv.slice(2);
assert.ok(args.includes('--workers-complete'), 'Explicit --workers-complete required; never overlap F50 workers');
const outputArg = args.find(value => value.startsWith('--output='))?.slice(9);
assert.ok(outputArg, 'Explicit new --output required');
const output = resolve(outputArg), partial = output + '.partial.jsonl';
const digest = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const noOverwrite = path => access(path).then(() => { throw Error('Refusing to overwrite ' + path); }, error => {
  if (error.code !== 'ENOENT') throw error;
});
await noOverwrite(output); await noOverwrite(partial);
const protocolPath = join(study, 'endpoint-symbolic-protocol.json');
const diagnostic = await json(protocolPath), campaign = await json(join(study, 'protocol.json'));
assert.equal(process.version, diagnostic.environment.node);
assert.equal(process.platform, diagnostic.environment.platform);
assert.equal(process.arch, diagnostic.environment.architecture);
const driverPath = args.find(value => value.startsWith('--driver-exit='))?.slice(14) ?? join(work, 'campaign/driver-exit.json');
const driverBytes = await readFile(driverPath), driver = JSON.parse(driverBytes);
assert.equal(driver.complete, true, 'All original F50 workers must be complete');
const resultPath = join(study, 'results.json'), resultBytes = await readFile(resultPath), results = JSON.parse(resultBytes);
assert.equal(diagnostic.expectedEndpoints, 18); assert.equal(results.rows.length, 18);
assert.equal(campaign.order.length, 18); assert.equal(diagnostic.expectedAnalyses, 24);
assert.equal(diagnostic.scriptSha256, digest(await readFile(new URL(import.meta.url))), 'Diagnostic script changed after protocol selection');
assert.equal(diagnostic.parentProtocolSha256, digest(await readFile(join(study, 'protocol.json'))));
assert.equal(diagnostic.parentSnapshotSha256, digest(await readFile(join(study, 'snapshot.json'))));
const bindings = await json(join(study, 'execution-bindings.json'));
for (const path of campaign.boundScripts)
  assert.equal(digest(await readFile(join(repo, path))), bindings.files[path], 'Original F50 study script changed: ' + path);
const assignmentKey = value => [value.repeat, value.task, value.arm].join(':');
assert.deepEqual(results.rows.map(assignmentKey).sort(), campaign.order.map(assignmentKey).sort());
assert.equal(new Set(results.rows.map(row => row.name)).size, 18);
const dependencies = resolve(args.find(value => value.startsWith('--dependencies='))?.slice(15) ?? dependencyRoot);
assert.equal(digest(await readFile(join(dependencies, 'package-lock.json'))), campaign.execution.dependencyLockSha256);
assert.equal(digest(await readFile(join(dependencies, 'package-lock.json'))),
  digest(await readFile(join(study, 'dependency-package-lock.json'))));
const dependencyBindings = Object.entries(bindings.files).filter(([path, value]) =>
  path.endsWith('/dependencies/node_modules') && value && typeof value === 'object');
assert.equal(dependencyBindings.length, 1, 'Expected the original copied-dependency file bindings');
for (const [path, expected] of Object.entries(dependencyBindings[0][1]))
  assert.equal(digest(await readFile(join(dependencies, 'node_modules', path))), expected,
    'Pinned witness dependency changed: ' + path);
const localRequire = createRequire(join(dependencies, 'package.json'));
const ts = localRequire('typescript');
assert.equal(ts.version, diagnostic.environment.typescript);
assert.equal(localRequire('tsx/package.json').version, diagnostic.environment.tsx);
const runtimeRoot = join(work, 'frozen/current'), snapshot = await json(join(study, 'snapshot.json'));
const runtimeHashes = {};
async function verifyRuntime() {
  for (const [path, expected] of Object.entries(snapshot.files)) {
    const actual = digest(await readFile(join(runtimeRoot, path)));
    assert.equal(actual, expected, 'Frozen F50 runtime changed: ' + path);
    runtimeHashes[path] = actual;
  }
}
await verifyRuntime();
assert.deepEqual(await solverIdentity(campaign.solver.path), campaign.solver, 'Pinned Z3 environment changed');
const runtime = join(runtimeRoot, 'agent-runtime/dist/harness');
const { LightWorkspace } = await import(pathToFileURL(join(runtime, 'light-workspace.js')));
const previousSolver = process.env.BLAME_Z3_PATH;
process.env.BLAME_Z3_PATH = campaign.solver.path;
const parent = await mkdtemp(join(work, 'endpoint-symbolic-'));
await mkdir(dirname(output), { recursive: true });
await writeFile(partial, '', { flag: 'wx' });
const rows = [];
const git = (argv, cwd) => execFileSync('git', argv, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
async function sourceHashes(root) {
  const paths = [...new Set(git(['ls-files', '-co', '--exclude-standard', '-z'], root).split('\0').filter(Boolean))].sort();
  const hashes = {};
  for (const path of paths) {
    const absolute = join(root, path);
    try {
      const metadata = await lstat(absolute);
      hashes[path] = metadata.isSymbolicLink() ? 'symlink:' + digest(await readlink(absolute))
        : digest(await readFile(absolute));
    } catch (error) { if (error.code === 'ENOENT') hashes[path] = 'absent'; else throw error; }
  }
  return hashes;
}
function safePath(path) {
  assert.ok(typeof path === 'string' && path && !path.startsWith('/') && !path.includes('\0') &&
    !path.split(/[\\/]/).includes('..'), 'Expected a workspace-relative captured path');
  const value = relative(parent, resolve(parent, path));
  assert.ok(value && value !== '..' && !value.startsWith('../') && !value.startsWith('/'));
  return path;
}
function expectedValue(id, input) {
  if (id === 'availableCredit') {
    const remainder = (input.limit > 0 ? input.limit : 0) - (input.balance > 0 ? input.balance : 0) -
      (input.reserved > 0 ? input.reserved : 0);
    return remainder > 0 ? remainder : 0;
  }
  if (id === 'lowerTierUnits') {
    const end = input.last < input.boundary ? input.last : input.boundary;
    return input.first > input.last ? 0 : end >= input.first ? end - input.first + 1 : 0;
  }
  if (id === 'tierCost') return input.lowerUnits * (input.lowerRate > 0 ? input.lowerRate : 0) +
    input.upperUnits * (input.upperRate > 0 ? input.upperRate : 0);
  if (id === 'overlapLength') {
    if (input.endA <= input.startA || input.endB <= input.startB) return 0;
    const start = input.startA > input.startB ? input.startA : input.startB;
    const end = input.endA < input.endB ? input.endA : input.endB;
    return end > start ? end - start : 0;
  }
  throw Error('Unknown fixed diagnostic property ' + id);
}
async function isolatedActualJs(root, request, witness) {
  const input = witness.inputs, names = request.parameters;
  assert.deepEqual(Object.keys(input).sort(), names.slice().sort());
  for (const [name, value] of Object.entries(input)) {
    const domain = request.input.inputs[name];
    assert.ok(Number.isSafeInteger(value) && value >= domain.min && value <= domain.max);
  }
  const path = request.input.target.split('#')[0], text = await readFile(join(root, path), 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === request.id && statement.body)
      functions.push({ node: statement, text: statement.getText(source) });
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === request.id && declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)))
        functions.push({ node: declaration.initializer,
          text: `const ${request.id} = ${declaration.initializer.getText(source)};` });
    }
  }
  if (functions.length !== 1) return { status: 'unavailable', reason: 'isolated_declaration_not_unique' };
  const extracted = functions[0], childSource = extracted.text + '\n' +
    `process.stdout.write(JSON.stringify({result:${request.id}(...${JSON.stringify(names.map(name => input[name]))})}) + "\\n");\n`;
  const child = join(parent, 'isolated-' + rows.length + '-' + request.id + '.mts');
  await writeFile(child, childSource, { flag: 'wx' });
  const run = spawnSync(process.execPath, ['--import', join(dependencies, 'node_modules/tsx/dist/loader.mjs'), child], {
    cwd: parent, encoding: 'utf8', timeout: diagnostic.environment.witnessTimeoutMs,
    maxBuffer: diagnostic.environment.witnessOutputBytes, env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' },
  });
  await rm(child);
  const base = { method: 'isolated_actual_js', moduleIntegration: false, modelRepair: false,
    sourceSha256: digest(text), declarationSha256: digest(extracted.text), childSourceSha256: digest(childSource),
    witnessSha256: digest(JSON.stringify(witness)), parameterOrder: names,
    rangeUtf8: [Buffer.byteLength(text.slice(0, extracted.node.getStart(source))), Buffer.byteLength(text.slice(0, extracted.node.end))],
    exitCode: run.status, signal: run.signal, error: run.error?.code ?? null,
    stdoutSha256: digest(run.stdout ?? ''), stdoutBytes: Buffer.byteLength(run.stdout ?? ''),
    stderrSha256: digest(run.stderr ?? ''), stderrBytes: Buffer.byteLength(run.stderr ?? '') };
  if (run.status !== 0 || run.error || run.signal) return { ...base, status: 'unavailable', reason: 'isolated_process_failed' };
  try {
    const actual = JSON.parse(run.stdout).result, expected = expectedValue(request.id, input);
    return { ...base, status: 'executed', actual, expected,
      matchesSymbolicResult: actual === witness.result, propertyViolated: actual !== expected };
  } catch { return { ...base, status: 'unavailable', reason: 'invalid_isolated_process_output' }; }
}
try {
  for (const row of results.rows) {
    const traceBytes = await readFile(join(study, 'traces', row.name + '.json.gz'));
    assert.equal(digest(traceBytes), row.traceSha256);
    const trace = JSON.parse(gunzipSync(traceBytes)); assert.equal(trace.name, row.name);
    const bytes = name => {
      const file = trace.files[name], value = Buffer.from(file.base64, 'base64');
      assert.equal(value.length, file.bytes); assert.equal(digest(value), file.sha256);
      if (row.hashes[name]) assert.equal(digest(value), row.hashes[name]);
      return value;
    };
    const patch = bytes('workspace.diff'), grade = JSON.parse(bytes('score.json'));
    const root = join(parent, safePath(row.name)); await prepare(root, row.task);
    const patchPath = join(parent, row.name + '.patch'); await writeFile(patchPath, patch);
    if (patch.length) git(['apply', '--binary', patchPath], root);
    for (const path of grade.protectedPaths) {
      safePath(path);
      assert.ok(!/^(?:packages|apps)\/.+\.ts$/.test(path) || path.endsWith('/original.test.ts'),
        'Protected-check reconstruction must not repair model production source');
      const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', path], { cwd: root, stdio: 'ignore' }).status === 0;
      if (tracked) git(['restore', '--source=HEAD', '--', path], root);
      else await rm(join(root, path), { recursive: true, force: true });
    }
    const before = await sourceHashes(root), requests = diagnostic.requests.filter(request => request.task === row.task);
    assert.equal(requests.length, row.task === 'inclusive-tier-allocation' ? 2 : 1);
    const workspace = new LightWorkspace(root, { sessionId: 'endpoint-symbolic-' + row.name });
    const checksBefore = await workspace.readCode({ target: '@checks' }, {});
    const observations = [];
    for (const request of requests) {
      const result = await workspace.runTask(structuredClone(request.input), {}), serialized = JSON.stringify(result);
      const data = result.status === 'ok' ? result.data : undefined;
      if (data) assert.equal(data.validationAdmission, false);
      let witnessReplay;
      if (data?.status === 'counterexample') {
        assert.ok(data.witness); assert.equal(data.sourceSha256, before[request.input.target.split('#')[0]]);
        witnessReplay = await isolatedActualJs(root, request, data.witness);
      }
      observations.push({ id: request.id, input: request.input, interpretation: request.interpretation,
        toolStatus: result.status, serializedResultSha256: digest(serialized), serializedResultBytes: Buffer.byteLength(serialized),
        ...(data ? { status: data.status, reason: data.reason, sourceSha256: data.sourceSha256,
          sourceRevisionId: data.sourceRevisionId, target: data.target, validationAdmission: data.validationAdmission,
          ...(data.solver ? { solver: data.solver } : {}), ...(data.witness ? { witness: data.witness } : {}) }
          : { status: 'blocked', reason: result.message, category: result.category }),
        ...(witnessReplay ? { witnessReplay } : {}) });
    }
    const checksAfter = await workspace.readCode({ target: '@checks' }, {}), after = await sourceHashes(root);
    const sourceUnchanged = JSON.stringify(before) === JSON.stringify(after);
    const checksUnchanged = JSON.stringify(checksBefore) === JSON.stringify(checksAfter);
    const observed = { name: row.name, repeat: row.repeat, task: row.task, arm: row.arm,
      patchSha256: digest(patch), traceSha256: row.traceSha256, sourceHashesBefore: before, sourceHashesAfter: after,
      sourceUnchanged, checksBeforeSha256: digest(JSON.stringify(checksBefore)),
      checksAfterSha256: digest(JSON.stringify(checksAfter)), checksUnchanged, observations };
    rows.push(observed); await appendFile(partial, JSON.stringify(observed) + '\n');
    assert.equal(sourceUnchanged, true); assert.equal(checksUnchanged, true);
    await rm(root, { recursive: true }); await rm(patchPath);
    console.log(JSON.stringify({ phase: 'post_hoc_endpoint_symbolic', name: row.name,
      outcomes: observations.map(item => ({ id: item.id, status: item.status, reason: item.reason })) }));
  }
  assert.equal(rows.length, 18); assert.equal(rows.reduce((n, row) => n + row.observations.length, 0), 24);
  await verifyRuntime(); assert.deepEqual(await solverIdentity(campaign.solver.path), campaign.solver);
  const all = rows.flatMap(row => row.observations), counts = {};
  for (const observation of all) counts[observation.status] = (counts[observation.status] ?? 0) + 1;
  const evidence = { schemaVersion: 1, phase: 'F50-post-hoc-endpoint-symbolic', createdAtUTC: new Date().toISOString(),
    knownDiagnostic: true, selectedAfterCompletedTrials: diagnostic.selectedAfterCompletedTrials,
    outcomesAvailableAtRegistration: diagnostic.outcomesAvailableAtRegistration,
    modelRequests: 0, agentSuccessesAdded: 0,
    protocolSha256: digest(await readFile(protocolPath)), resultsSha256: digest(resultBytes),
    driverExit: { complete: driver.complete, sha256: digest(driverBytes) },
    scriptSha256: digest(await readFile(new URL(import.meta.url))), runtimeSha256: digest(JSON.stringify(runtimeHashes)),
    environment: { node: process.version, typescript: ts.version, tsx: localRequire('tsx/package.json').version,
      solver: campaign.solver, dependencyLockSha256: campaign.execution.dependencyLockSha256 },
    summary: { endpoints: rows.length, analyses: all.length, counts,
      isolatedJsWitnesses: all.filter(item => item.witnessReplay?.status === 'executed').length,
      isolatedJsConfirmedViolations: all.filter(item => item.witnessReplay?.matchesSymbolicResult && item.witnessReplay.propertyViolated).length },
    partialSha256: digest(await readFile(partial)), rows, limitations: diagnostic.limitations };
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, summary: evidence.summary, modelRequests: 0 }));
} finally {
  if (previousSolver === undefined) delete process.env.BLAME_Z3_PATH; else process.env.BLAME_Z3_PATH = previousSolver;
  await rm(parent, { recursive: true, force: true });
}
