// Post-dispatch metadata audit; the frozen trials and their scores are unchanged.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {digest, atomicJson, trialName} from '../durable-campaign.mjs';
import {study} from './inputs.mjs';
const protocol = JSON.parse(await readFile(join(study, 'model-protocol.json')));
const hash = digest(await readFile(join(study, 'model-protocol.json')));
const trials = [];
for (const slot of protocol.order) {
  const name = trialName(slot); let bytes;
  try {bytes = await readFile(join(study, 'checkpoints', name + '.json.gz'));}
  catch (e) {if (e.code === 'ENOENT') break; throw e;}
  const c = JSON.parse(gunzipSync(bytes)); assert.equal(c.protocolHash, hash);
  const file = path => {
    const record = c.files[path]; if (!record) return '';
    const bytes = Buffer.from(record.base64, 'base64'); assert.equal(digest(bytes), record.sha256); return bytes.toString();
  };
  const jsonl = path => file(path).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const tools = JSON.parse(file('tool-ledger.json')), wire = jsonl('wire-contracts.jsonl');
  const offered = new Map();
  function observe(result, id) {
    if (result?.data?.testValidationScope) {
      const sha = digest(JSON.stringify(result.data.testValidationScope));
      offered.set(sha, {scopeSha256: sha, callIdSha256: digest(id ?? ''),
        source: result.data.reporting?.invocationSourceRevisionId ?? null});
    }
    if (result?.data?.completed) observe(result.data.completed, id);
  }
  for (const tool of tools) if (tool.tool === 'run_task') observe(tool.output, tool.toolCallId ?? tool.toolCall?.id);
  const queue = new Map();
  for (const request of jsonl('receipt-metadata.jsonl')) {
    const items = queue.get(request.requestBodySha256) ?? []; items.push(request); queue.set(request.requestBodySha256, items);
  }
  const forwarded = [];
  for (const request of wire) {
    const observation = queue.get(request.requestBodySha256)?.shift();
    if (observation && !request.budgetRejected) forwarded.push(...observation.receipts);
  }
  const exact = new Set(forwarded.filter(r => offered.get(r.scopeSha256)?.callIdSha256 === r.callIdSha256).map(r => r.scopeSha256));
  trials.push({...slot, name, firstContract: wire[0] ?? null,
    uniqueScopeOffers: offered.size, uniqueExactForwardedScopes: exact.size,
    scopeForwardingOccurrences: forwarded.length,
    groupedReads: tools.filter(t => t.tool === 'read_code' && Array.isArray(t.input?.reads)).map(t => ({
      callId: t.toolCallId ?? t.toolCall?.id, requested: t.input.reads.length,
      emitted: t.output?.data?.results?.length ?? null, remaining: t.output?.data?.remainingReads?.length ?? null,
      status: t.output?.status ?? 'unknown'})),
    tools: tools.length, reads: tools.filter(t => t.tool === 'read_code').length,
    blockedEdits: tools.filter(t => t.tool === 'edit_code' && t.output?.status === 'blocked').length,
    compilerOffers: c.row.compilerOffers,
    requiredChecksRetained: c.row.requiredInvocationsReported});
}
const contracts = [];
for (const trial of trials.filter(t => !['reference', 'cline'].includes(t.arm))) {
  const reference = trials.find(r => r.task === trial.task && r.repeat === trial.repeat && r.arm === 'reference');
  if (!reference?.firstContract || !trial.firstContract) continue;
  contracts.push({task: trial.task, repeat: trial.repeat, panel: trial.panel,
    sameFirstPrompt: reference.firstContract.promptSha256 === trial.firstContract.promptSha256,
    sameFirstTools: reference.firstContract.toolsSha256 === trial.firstContract.toolsSha256,
    expectedSchemaChange: trial.arm === 'batch',
    sameModelEffortOutputLimit: JSON.stringify([reference.firstContract.model, reference.firstContract.reasoning, reference.firstContract.maximumOutputTokens]) === JSON.stringify([trial.firstContract.model, trial.firstContract.reasoning, trial.firstContract.maximumOutputTokens])});
}
const report = {complete: trials.length === protocol.order.length, trials, contracts,
  boundary: 'Exact hash/call correlation at the fetch boundary; not proof of remote ingestion, model attention, reasoning or task benefit. Repeated forwarded occurrences are not independent offers. Prompt/schema differences remain visible, never normalized after outcomes.'};
await atomicJson(join(study, 'mechanism-audit.json'), report);
console.log(JSON.stringify({complete: report.complete, trials: trials.length, contracts}, null, 2));
