// Post-dispatch analysis only: never starts a model or alters scoring criteria.
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {atomicJson, digest, trialName} from '../durable-campaign.mjs';
import {study} from './inputs.mjs';
const p = JSON.parse(await readFile(join(study, 'model-protocol.json')));
const protocolHash = digest(await readFile(join(study, 'model-protocol.json')));
const available = new Set(await readdir(join(study, 'checkpoints')));
const rows = [], receipts = [];
for (const slot of p.order) {
  const name = trialName(slot), file = name + '.json.gz';
  if (!available.has(file)) break;
  const bytes = await readFile(join(study, 'checkpoints', file));
  const checkpoint = JSON.parse(gunzipSync(bytes));
  assert.equal(checkpoint.protocolHash, protocolHash);
  assert.equal(checkpoint.name, name);
  for (const [path, record] of Object.entries(checkpoint.files)) {
    const bytes = Buffer.from(record.base64, 'base64');
    assert.equal(bytes.length, record.bytes, path);
    assert.equal(digest(bytes), record.sha256, path);
  }
  rows.push(checkpoint.row); receipts.push({name, sha256: digest(bytes)});
}
const total = (r, field) => r.every(x => field(x) !== null && field(x) !== undefined)
  ? r.reduce((n, x) => n + field(x), 0) : null;
function resources(r) {
  return {assignments: r.length,
    tokens: total(r, x => x.usage.input === null || x.usage.output === null ? null : x.usage.input + x.usage.output),
    input: total(r, x => x.usage.input), output: total(r, x => x.usage.output),
    cacheRead: total(r, x => x.usage.cacheRead), cacheWrite: total(r, x => x.usage.cacheWrite),
    sdkUsd: total(r, x => x.usage.cost), sdkMs: total(r, x => x.sdkDurationMs),
    outerMs: total(r, x => x.exit.durationMs), requests: total(r, x => x.forwardedRequests),
    observerMs: total(r, x => x.sourceAuditObservationMs), toolMs: total(r, x => x.toolTimeMs),
    missingCost: r.filter(x => x.usage.cost === null).length,
    reconciledTokensCost: r.filter(x => x.usage.tokensCostReconciled).length,
    fullyReconciled: r.filter(x => x.usage.complete).length};
}
function difference(a, b) {
  const left = resources(a), right = resources(b), percent = {};
  for (const field of ['tokens', 'sdkUsd', 'sdkMs', 'requests', 'toolMs'])
    percent[field] = left[field] !== null && right[field] > 0 ? 100 * (left[field] / right[field] - 1) : null;
  return {candidate: left, comparator: right, changePercent: percent};
}
const panels = p.panels.map(panel => {
  const selected = rows.filter(r => r.panel === panel.id);
  const arms = Object.fromEntries(panel.arms.map(arm => {
    const r = selected.filter(x => x.arm === arm);
    return [arm, {...resources(r), official: r.filter(x => x.officialRuntimeSuccess).length,
      source: r.filter(x => x.sourceSuccess).length, strict: r.filter(x => x.strictSuccess).length,
      finalRequired: r.filter(x => x.requiredInvocationsReported).length,
      groupedReads: r.reduce((n, x) => n + x.groupedReads, 0),
      compilerRepairOffers: r.reduce((n, x) => n + x.compilerRepairOffers, 0),
      followedCompilerOffers: r.reduce((n, x) => n + x.compilerOffers.filter(o => o.directCompilerFollow).length, 0),
      scopeReceipts: r.reduce((n, x) => n + x.scopeReceipts, 0),
      failures: r.filter(x => !x.strictSuccess).map(x => ({name: x.name, status: x.status,
        source: x.sourceSuccess, required: x.requiredInvocationsReported, layout: x.score.strictLayout,
        retrieval: x.solutionRetrieval, endpointCodes: x.score.endpoints.map(e => [e.name, e.exitCode])}))}];
  }));
  const candidateArm = panel.arms[1], pairs = {};
  for (const comparatorArm of ['reference', 'cline']) {
    const candidate = selected.filter(r => r.arm === candidateArm);
    const matched = candidate.map(a => ({a, b: selected.find(b => b.arm === comparatorArm && b.task === a.task && b.repeat === a.repeat)})).filter(x => x.b);
    const strict = matched.filter(({a, b}) => a.strictSuccess && b.strictSuccess);
    const compare = pairs => difference(pairs.map(x => x.a), pairs.map(x => x.b));
    pairs[comparatorArm] = {allMatched: compare(matched), jointlyStrict: compare(strict),
      pairNames: strict.map(x => x.a.repeat + '-' + x.a.task),
      omittedPairs: strict.length > 1 ? strict.map((_, i) => ({omitted: strict[i].a.repeat + '-' + strict[i].a.task, ...compare(strict.filter((_, j) => j !== i)).changePercent})) : [],
      omittedTasks: panel.tasks.map(task => ({omitted: task.id, ...compare(strict.filter(x => x.a.task !== task.id)).changePercent}))};
  }
  return {id: panel.id, complete: selected.length === panel.tasks.length * p.repetitions * panel.arms.length, arms, pairs};
});
const report = {protocolHash, complete: rows.length === p.order.length, completed: rows.length,
  planned: p.order.length, panels, allAssignments: resources(rows), rows,
  accounting: {tokens: 'input + output; cache is reported as an input subset, never added again',
    cost: 'SDK estimate, not invoice/EUR conversion', missing: 'null stays unknown; missing-cost scheduling reserve is not a measured charge',
    earlierStudyObservedSdkUsd: 11.40055596, earlierUnknownReservationUsd: 17.14,
    newObservedSdkUsd: rows.reduce((n, r) => n + (r.usage.cost ?? 0), 0),
    newMissingCostReserveUsd: rows.filter(r => r.usage.cost === null).length * p.budgets.perTrialMissingCostReserveUsd},
  boundary: 'Two dependent repetitions of two constructed tasks per panel; separate SDK0.2.0 cohort. Strict, source and official success are distinct; failures remain in assigned totals. Paired resource estimates are descriptive, not general causal claims.'};
await atomicJson(join(study, 'checkpoint-index.json'), {protocolHash, completed: rows.length, planned: p.order.length, receipts});
await atomicJson(join(study, 'model-results.json'), report);
console.log(JSON.stringify({complete: report.complete, completed: rows.length, panels}, null, 2));
