import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {study, work, repo} from './inputs.mjs';
import {digest, atomicJson} from '../durable-campaign.mjs';
const bytes = await readFile(join(study, 'model-protocol.json')), parent = JSON.parse(bytes);
const interruption = JSON.parse(await readFile(join(study, 'interrupted-trial.json')));
assert.equal(interruption.protocolHash, digest(bytes));
assert.equal(interruption.modelRetried, false);
const original = await readFile('/workspace/blame-cloud/f65/original-coordinator.mjs');
assert.equal(digest(original), parent.boundScripts['campaign.mjs']);
const boundScripts = {...parent.boundScripts};
for (const path of Object.keys(boundScripts)) {
  const current = digest(await readFile(join(import.meta.dirname, path)));
  if (path === 'campaign.mjs') boundScripts[path] = current;
  else assert.equal(current, boundScripts[path], 'Original worker/observer changed: ' + path);
}
boundScripts['continue.mjs'] = digest(await readFile(join(import.meta.dirname, 'continue.mjs')));
const checkpoints = await Promise.all(parent.order.slice(0, 8).map(async slot => {
  const path = join(study, 'checkpoints', `${slot.repeat}-${slot.task}-${slot.arm}.json.gz`);
  return {slot, sha256: digest(await readFile(path))};
}));
const knownCost = JSON.parse(await readFile(join(work, 'campaign/rows.json'))).reduce((n, r) => n + (r.usage.cost ?? 0), 0);
const protocol = {...parent, kind: 'pre-outcome continuation of only the remaining original assignments',
  parentProtocolHash: digest(bytes), coordinatorSourceHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8'}).trim(),
  boundAtUTC: new Date().toISOString(), order: parent.order.slice(9), boundScripts,
  budgets: {...parent.budgets, observedStudyStopUsd: parent.budgets.observedStudyStopUsd - knownCost - interruption.schedulingReserveUsd},
  continuation: {completedCheckpoints: checkpoints, interruptedAssignment: parent.order[8],
    interruptedTrialSha256: digest(await readFile(join(study, 'interrupted-trial.json.gz'))),
    modelRetried: false, replacementAssignments: 0, runtimeSourceHeadUnchanged: parent.sourceHead,
    coordinatorChange: 'Only directories and one-new-trial-per-process scheduling; model execution, inputs, grading, observers and per-trial bounds unchanged.',
    accounting: 'Original eight completed costs and USD1.50 unknown-trial scheduling reserve deducted from the original study stop; not an invoice guarantee.',
    singleTrialProcess: true, cause: interruption.coordinatorExitCause}};
await atomicJson(join(study, 'continuation/model-protocol.json'), protocol, {exclusive: true});
await atomicJson(join(study, 'campaign-status.json'), {complete: false, terminated: true, completed: 8, interrupted: 1, unstartedAtInterruption: 15, planned: 24});
console.log('Bound the original 15 remaining assignments; no replacements or model requests.');
