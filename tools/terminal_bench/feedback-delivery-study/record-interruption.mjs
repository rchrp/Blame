// Explicit forensic capture. Never fabricates a model exit or retries a trial.
import assert from 'node:assert/strict';
import {readFile, writeFile, readdir, access} from 'node:fs/promises';
import {join} from 'node:path';
import {hostname} from 'node:os';
import {execFileSync, spawnSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {study, work} from './inputs.mjs';
import {sourceEpoch} from './source-epoch.mjs';
import {atomicJson, atomicWrite, digest, trialName} from '../durable-campaign.mjs';
const json = async path => JSON.parse(await readFile(path));
const protocolBytes = await readFile(join(study, 'model-protocol.json')), p = JSON.parse(protocolBytes);
const slot = p.order[8], name = trialName(slot), directory = join(work, 'campaign', name);
assert.equal(name, '2-map-context-reference');
const lease = await json(join(work, 'campaign/driver-lease.json'));
assert.equal(lease.host, hostname());
assert.equal(lease.boot, (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim());
const processStatus = await readFile('/proc/' + lease.pid + '/status', 'utf8');
assert.match(processStatus, /^State:\s+Z /m, 'Do not capture while the original coordinator is running');
for (const file of ['model-exit.json', 'result.json']) await access(join(directory, file)).then(() => {throw Error('Exit evidence exists; inspect instead');}, e => {if (e.code !== 'ENOENT') throw e;});
const root = join(work, 'active/workspace'), epoch = sourceEpoch(root);
const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
let patch = git(['diff', '--binary', p.inputs[slot.task].head]);
for (const path of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
  const r = spawnSync('git', ['diff', '--no-index', '--binary', '--', '/dev/null', path], {cwd: root, encoding: 'utf8'});
  assert.ok([0, 1].includes(r.status)); patch += r.stdout;
}
await writeFile(join(directory, 'partial-workspace.diff'), patch);
await atomicJson(join(directory, 'source-at-capture.json'), epoch, {exclusive: true});
execFileSync('tar', ['-czf', join(directory, 'partial-workspace.tar.gz'), '--exclude=node_modules', '-C', root, '.']);
assert.deepEqual(sourceEpoch(root), epoch);
const rows = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s).event);
const usage = rows.filter(e => e.type === 'usage').map(e => e.payload.usage);
const wire = (await readFile(join(directory, 'wire-contracts.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
const record = {slot, name, protocolHash: digest(protocolBytes), capturedAtUTC: new Date().toISOString(),
  state: 'model_exit_unknown', processState: 'original coordinator is a same-host same-boot zombie; no live local model worker found on inspection',
  coordinatorExitCause: 'unknown; execution session disappeared around its 20-minute lifetime, causality unproved',
  modelRetried: false, officialSuccess: false, finalSourceKnown: false,
  forwardedRequests: wire.filter(r => !r.budgetRejected).length, usageReports: usage.length,
  lastObservedCumulativeUsage: usage.at(-1) ?? null,
  aggregateInput: null, aggregateOutput: null, aggregateSdkCost: null, osExitCode: null, sdkDurationMs: null,
  schedulingReserveUsd: 1.5, reserveBoundary: 'Scheduling allowance, not a measured charge or invoice bound. Retain partial observed usage without treating it as a complete aggregate.',
  sourceAtCapture: epoch, partialArchiveSha256: digest(await readFile(join(directory, 'partial-workspace.tar.gz'))),
  remainingOrder: p.order.slice(9), completedBeforeInterruption: 8};
await atomicJson(join(study, 'interrupted-trial.json'), record, {exclusive: true});
const files = {};
for (const entry of await readdir(directory, {withFileTypes: true})) {
  if (!entry.isFile() || entry.name.endsWith('.tar.gz')) continue;
  const bytes = await readFile(join(directory, entry.name));
  for (const [key, value] of Object.entries(process.env)) if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)$/.test(key) && value.length >= 16)
    assert.ok(!bytes.includes(Buffer.from(value)), 'Credential found; refuse publication');
  files[entry.name] = {bytes: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64')};
}
await atomicWrite(join(study, 'interrupted-trial.json.gz'), gzipSync(JSON.stringify({kind: 'incomplete-trial', record, files})), {exclusive: true});
console.log('Preserved incomplete trial; no exit fabricated, no model retried.');
