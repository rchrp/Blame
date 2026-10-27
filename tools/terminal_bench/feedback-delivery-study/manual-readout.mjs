// Explicit post-hoc evidence sensitivity, separate from frozen automatic scores.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {evidence, file} from './evidence.mjs';
import {study, checks} from './inputs.mjs';
import {digest, atomicJson} from '../durable-campaign.mjs';
const {records, protocol, executionFinished} = await evidence();
const decisions = JSON.parse(await readFile(join(study, 'manual-check-audit.json')));
const overrides = new Map();
for (const decision of decisions.entries) {
  const c = records.find(c => c.name === decision.name); assert.ok(c && !c.partial);
  const tools = JSON.parse(file(c, 'tool-ledger.json'));
  const t = tools.find(t => (t.toolCallId ?? t.toolCall?.id) === decision.evidence.toolCallId); assert.ok(t);
  assert.equal(digest(JSON.stringify(t.input)), decision.evidence.inputSha256);
  assert.equal(digest(JSON.stringify(t.output)), decision.evidence.outputSha256);
  assert.equal(JSON.parse(file(c, 'source-at-exit.json')).sha256, decision.evidence.finalSourceSha256);
  assert.deepEqual(decision.evidence.commands.map(c => c.command), checks.map(c => 'npm run ' + c.task));
  assert.ok(decision.evidence.commands.every(c => c.observedChildExit === 0));
  overrides.set(decision.name, decision.acceptRequiredInvocations);
}
const rows = records.map(c => {
  const r = c.row, required = overrides.has(r.name) ? overrides.get(r.name) : r.requiredInvocationsReported;
  return {...r, manuallyReviewedRequired: overrides.has(r.name), auditedRequired: required,
    auditedStrict: r.officialRuntimeSuccess && r.sourceSuccess === true && r.score.strictLayout === true && required && r.solutionRetrieval === false};
});
const sum = (rows, f) => rows.every(r => f(r) !== null && f(r) !== undefined) ? rows.reduce((n, r) => n + f(r), 0) : null;
function resource(rows) {
  return {assignments: rows.length,
    tokens: sum(rows, r => r.usage.input === null || r.usage.output === null ? null : r.usage.input + r.usage.output),
    sdkUsd: sum(rows, r => r.usage.cost), sdkMs: sum(rows, r => r.sdkDurationMs), requests: sum(rows, r => r.forwardedRequests)};
}
function compare(pairs) {
  const candidate = resource(pairs.map(p => p.a)), comparator = resource(pairs.map(p => p.b)), changePercent = {};
  for (const f of ['tokens', 'sdkUsd', 'sdkMs', 'requests']) changePercent[f] = candidate[f] !== null && comparator[f] > 0 ? 100 * (candidate[f] / comparator[f] - 1) : null;
  return {candidate, comparator, changePercent};
}
const panels = protocol.panels.map(panel => {
  const selected = rows.filter(r => r.panel === panel.id), candidate = selected.filter(r => r.arm === panel.arms[1]);
  const arms = Object.fromEntries(panel.arms.map(arm => {
    const r = selected.filter(r => r.arm === arm);
    return [arm, {...resource(r), frozenAutomaticStrict: r.filter(r => r.strictSuccess).length,
      auditedStrict: r.filter(r => r.auditedStrict).length, auditedRequired: r.filter(r => r.auditedRequired).length}];
  }));
  const pairs = {};
  for (const arm of ['reference', 'cline']) {
    const matched = candidate.map(a => ({a, b: selected.find(b => b.arm === arm && a.task === b.task && a.repeat === b.repeat)})).filter(p => p.b);
    const strict = matched.filter(p => p.a.auditedStrict && p.b.auditedStrict);
    const source = matched.filter(p => p.a.sourceSuccess === true && p.b.sourceSuccess === true);
    pairs[arm] = {jointlyAuditedStrict: compare(strict), jointlySourceCorrect: compare(source),
      strictPairNames: strict.map(p => p.a.repeat + '-' + p.a.task),
      omittedStrictPairs: strict.length > 1 ? strict.map((_, i) => ({omitted: strict[i].a.repeat + '-' + strict[i].a.task, ...compare(strict.filter((_, j) => i !== j)).changePercent})) : [],
      omittedStrictTasks: panel.tasks.map(t => ({omitted: t.id, ...compare(strict.filter(p => p.a.task !== t.id)).changePercent}))};
  }
  return {id: panel.id, arms, pairs};
});
await atomicJson(join(study, 'manual-sensitivity.json'), {executionFinished, completeManualReview: decisions.complete,
  panels, rows: rows.map(r => ({name: r.name, auditedRequired: r.auditedRequired, auditedStrict: r.auditedStrict, frozenAutomaticStrict: r.strictSuccess})),
  boundary: 'Post-hoc manual acceptance of child-status/source-order evidence that the conservative frozen observer does not recognize. No automatic score, source, test layout, endpoint or consumption is rewritten. Missing recognition is distinct from a failed check; this sensitivity is not the pre-registered primary result.'});
console.log(JSON.stringify({panels}, null, 2));
