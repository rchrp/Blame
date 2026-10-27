import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {digest} from '../durable-campaign.mjs';
import {evidence} from './evidence.mjs';
test('retains an interrupted assignment between old and continued immutable checkpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'study-evidence-'));
  try {
    const slots = ['reference', 'batch', 'cline'].map(arm => ({repeat: 1, task: 'new', arm, panel: 'F'}));
    const protocol = JSON.stringify({order: slots}), hash = digest(protocol);
    await mkdir(join(directory, 'checkpoints')); await mkdir(join(directory, 'continuation/checkpoints'), {recursive: true});
    await writeFile(join(directory, 'model-protocol.json'), protocol);
    const continued = JSON.stringify({parentProtocolHash: hash});
    await writeFile(join(directory, 'continuation/model-protocol.json'), continued);
    for (const [i, root, h] of [[0, '', hash], [2, 'continuation', digest(continued)]]) {
      const name = `1-new-${slots[i].arm}`, row = {...slots[i], name, status: 'succeeded', strictSuccess: true};
      const score = Buffer.from(JSON.stringify(row));
      await writeFile(join(directory, root, 'checkpoints', name + '.json.gz'), gzipSync(JSON.stringify({name, protocolHash: h, row,
        files: {'score.json': {base64: score.toString('base64'), sha256: digest(score), bytes: score.length}}})));
    }
    await writeFile(join(directory, 'interrupted-trial.json.gz'), gzipSync(JSON.stringify({record: {name: '1-new-batch', modelRetried: false,
      protocolHash: hash, forwardedRequests: 3, lastObservedCumulativeUsage: {totalCost: .01}, schedulingReserveUsd: 1.5}, files: {}})));
    const result = await evidence({directory});
    assert.equal(result.executionFinished, true); assert.equal(result.modelCompleted, 2);
    assert.deepEqual(result.records.map(c => c.name), slots.map(s => `1-new-${s.arm}`));
    const missing = result.records[1].row;
    assert.equal(missing.strictSuccess, false); assert.equal(missing.sourceSuccess, null);
    assert.equal(missing.usage.cost, null); assert.equal(missing.usage.input, null);
    assert.equal(missing.usage.observedPartialCumulative.totalCost, .01);
    await writeFile(join(directory, 'continuation/model-protocol.json'), JSON.stringify({parentProtocolHash: 'wrong'}));
    await assert.rejects(evidence({directory}), /AssertionError/);
  } finally {await rm(directory, {recursive: true, force: true});}
});
