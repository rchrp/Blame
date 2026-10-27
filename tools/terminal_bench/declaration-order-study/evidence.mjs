import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {digest, trialName} from '../durable-campaign.mjs';
import {study} from './inputs.mjs';
const optional = path => readFile(path).catch(e => {if (e.code === 'ENOENT') return null; throw e;});
export async function evidence({directory = study} = {}) {
  const protocolBytes = await readFile(join(directory, 'model-protocol.json'));
  const protocol = JSON.parse(protocolBytes), protocolHash = digest(protocolBytes);
  const continued = await optional(join(directory, 'continuation/model-protocol.json'));
  const continuationHash = continued ? digest(continued) : null;
  if (continued) assert.equal(JSON.parse(continued).parentProtocolHash, protocolHash);
  const interrupted = await optional(join(directory, 'interrupted-trial.json.gz'));
  const partial = interrupted ? JSON.parse(gunzipSync(interrupted)) : null;
  const records = [];
  for (const slot of protocol.order) {
    const name = trialName(slot); let bytes = await optional(join(directory, 'checkpoints', name + '.json.gz'));
    let hash = protocolHash, path = 'checkpoints/' + name + '.json.gz';
    if (!bytes && continued) {
      bytes = await optional(join(directory, 'continuation/checkpoints', name + '.json.gz'));
      hash = continuationHash; path = 'continuation/checkpoints/' + name + '.json.gz';
    }
    let c;
    if (bytes) {
      c = JSON.parse(gunzipSync(bytes)); assert.equal(c.protocolHash, hash); assert.equal(c.name, name);
    } else if (partial?.record.name === name) {
      assert.equal(partial.record.protocolHash, protocolHash); assert.equal(partial.record.modelRetried, false);
      c = {files: partial.files, partial: true, name, protocolHash,
        row: {...slot, name, status: 'interrupted_unknown_exit', officialRuntimeSuccess: false,
          sourceSuccess: null, strictSuccess: false, requiredInvocationsReported: false, solutionRetrieval: null,
          usage: {input: null, output: null, cacheRead: null, cacheWrite: null, cost: null,
            complete: false, tokensCostReconciled: false, completeness: 'unavailable',
            observedPartialCumulative: partial.record.lastObservedCumulativeUsage},
          sdkDurationMs: null, exit: {code: null, signal: null, durationMs: null},
          forwardedRequests: partial.record.forwardedRequests, sourceAuditObservationMs: null, toolTimeMs: null,
          groupedReads: 0, compilerRepairOffers: 0, compilerOffers: [], scopeReceipts: 0,
          score: {strictLayout: null, endpoints: [], protectedPaths: [], deleted: [], changedPaths: [], newTests: []},
          schedulingReserveUsd: partial.record.schedulingReserveUsd,
          evidenceBoundary: 'Incomplete local capture, unknown actual exit/final source/aggregate consumption; not a model retry or a demonstrated behavioral failure.'}};
      bytes = interrupted; path = 'interrupted-trial.json.gz';
    } else continue;
    for (const [path, record] of Object.entries(c.files)) {
      const bytes = Buffer.from(record.base64, 'base64'); assert.equal(bytes.length, record.bytes, path); assert.equal(digest(bytes), record.sha256, path);
    }
    if (!c.partial && c.files['score.json']) assert.deepEqual(JSON.parse(Buffer.from(c.files['score.json'].base64, 'base64')), c.row);
    records.push({...c, receipt: {name, path, sha256: digest(bytes)}});
  }
  return {protocol, protocolHash, records, interruption: partial?.record ?? null,
    executionFinished: records.length === protocol.order.length,
    modelCompleted: records.filter(c => !c.partial).length};
}
export function file(c, path) {
  const r = c.files[path]; assert.ok(r, c.name + ': missing ' + path);
  const b = Buffer.from(r.base64, 'base64'); assert.equal(digest(b), r.sha256); return b;
}
