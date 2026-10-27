// Post-dispatch metadata audit; the frozen trials and their scores are unchanged.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {digest, atomicJson, trialName} from '../durable-campaign.mjs';
import {study,tasks,checksFor} from './inputs.mjs';
import {evidence} from './evidence.mjs';
const {protocol, records, executionFinished} = await evidence();
const trials = [];
for (const c of records.filter(c => !c.partial)) {
  const {name, row: slot} = c;
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
      const ids = offered.get(sha) ?? new Set(); ids.add(digest(id ?? '')); offered.set(sha, ids);
    }
    if (result?.data?.completed) observe(result.data.completed, id);
  }
  for (const tool of tools) if (tool.tool === 'run_task') observe(tool.output, tool.toolCallId ?? tool.toolCall?.id);
  const queue = new Map();
  for (const request of jsonl('receipt-metadata.jsonl')) {
    const items = queue.get(request.requestBodySha256) ?? []; items.push(request); queue.set(request.requestBodySha256, items);
  }
  const forwarded = [], advice=[],declarationReceipts=[];
  for (const request of wire) {
    const observation = queue.get(request.requestBodySha256)?.shift();
    if (observation && !request.budgetRejected) {forwarded.push(...observation.receipts);advice.push(...(observation.advice??[]));declarationReceipts.push(...(observation.declarations??[]));}
  }
  const exact = new Set(forwarded.filter(r => offered.get(r.scopeSha256)?.has(r.callIdSha256)).map(r => r.scopeSha256));
  const eventRows = jsonl('events.jsonl').map(r => r.event);
  const requiredTasks = new Set(checksFor(tasks.find(t=>t.id===slot.task)).map(c=>c.task));
  const compilerRecovery = [];
  for (let index = 0; index < eventRows.length; index++) {
    const e = eventRows[index], t = e?.payload, input = t?.toolCall?.input;
    if (e?.type !== 'tool' || t.phase !== 'finished' || t.toolCall?.name !== 'run_task' || input?.kind !== 'command' || !input.command.includes('tsc --noEmit')) continue;
    const completed = tools.find(x => (x.toolCallId ?? x.toolCall?.id) === (t.toolCallId ?? t.toolCall?.id));
    if (completed?.output?.status !== 'blocked' || !/error TS[0-9]+/u.test(completed.output.message ?? '')) continue;
    const after = eventRows.map((event, position) => ({event, position})).slice(index + 1);
    const next = after.find(({event}) => event?.type === 'tool' && event.payload?.phase === 'started' && event.payload.toolCall?.name === 'run_task' &&
      ((event.payload.toolCall.input?.kind === 'command' && event.payload.toolCall.input.command === input.command) ||
       (event.payload.toolCall.input?.kind === 'project' && requiredTasks.has(event.payload.toolCall.input.task))));
    const firstRequired = after.find(({event}) => event?.type === 'tool' && event.payload?.phase === 'started' && event.payload.toolCall?.name === 'run_task' && requiredTasks.has(event.payload.toolCall.input?.task));
    const nextId = next?.event.payload.toolCallId ?? next?.event.payload.toolCall?.id;
    const end = after.find(({event}) => event?.type === 'tool' && event.payload?.phase === 'finished' && (event.payload.toolCallId ?? event.payload.toolCall?.id) === nextId);
    compilerRecovery.push({failureCallId: t.toolCallId ?? t.toolCall?.id, nextValidationCallId: nextId ?? null,
      exactCompilerIsNext: next?.event.payload.toolCall?.input?.command === input.command,
      compilerFinishedBeforeRequiredStarted: next?.event.payload.toolCall?.input?.command === input.command && end !== undefined && (firstRequired === undefined || end.position < firstRequired.position),
      ignoredInspectionCommands: true});
  }
  const iterationTools = new Map(); let iteration = 0;
  for (const {event} of jsonl('events.jsonl')) {
    if (event?.type === 'notice' && event.payload?.message === 'Agent iteration started.') iteration++;
    if (event?.type === 'tool' && event.payload?.phase === 'started') {
      const group = iterationTools.get(iteration) ?? []; group.push(event.payload.toolCall?.name); iterationTools.set(iteration, group);
    }
  }
  const multiReadIterations = [...iterationTools.entries()].filter(([, names]) => names.filter(n => n === 'read_code').length > 1).map(([iteration, names]) => ({iteration, reads: names.filter(n => n === 'read_code').length}));
  const declarationOffers=tools.filter(t=>t.tool==='search_code'&&t.output?.data?.declarationDiscovery).map(t=>{
    const id=t.toolCallId??t.toolCall?.id,finished=eventRows.findIndex(e=>e?.type==='tool'&&e.payload?.phase==='finished'&&(e.payload.toolCallId??e.payload.toolCall?.id)===id);
    const candidates=t.output.data.declarationCandidates??[],targets=new Set(candidates.map(c=>c.target)),received=declarationReceipts.filter(r=>r.callIdSha256===digest(id));
    const subsequentReads=eventRows.slice(finished+1).filter(e=>e?.type==='tool'&&e.payload?.phase==='started'&&e.payload.toolCall?.name==='read_code'&&targets.has(e.payload.toolCall.input?.target)).map(e=>({targetSha256:digest(e.payload.toolCall.input.target),callId:e.payload.toolCallId??e.payload.toolCall.id}));
    return {callId:id,query:t.input?.query,scope:t.input?.scope??null,discovery:t.output.data.declarationDiscovery,candidates:candidates.map(c=>({path:c.path,kind:c.kind,qualifiedName:c.qualifiedName,targetSha256:digest(c.target)})),forwardedOccurrences:received.length,exactCandidatePayloadForwarded:received.some(r=>JSON.stringify(r.candidates.map(c=>[c.path,c.kind,c.qualifiedName,c.targetSha256]))===JSON.stringify(candidates.map(c=>[c.path,c.kind,c.qualifiedName,digest(c.target)]))),subsequentExplicitTargetReads:subsequentReads};
  });
  trials.push({panel: slot.panel, task: slot.task, arm: slot.arm, repeat: slot.repeat, name, declarationOffers, compilerRecovery, multiReadIterations, firstContract: wire[0] ?? null,
    advice:{fullOccurrences:advice.filter(r=>r.kind==='full').length,referenceOccurrences:advice.filter(r=>r.kind==='reference').length,uniqueFullCalls:new Set(advice.filter(r=>r.kind==='full').map(r=>r.callIdSha256)).size,uniqueReferenceCalls:new Set(advice.filter(r=>r.kind==='reference').map(r=>r.callIdSha256)).size,metadataBytes:advice.reduce((n,r)=>n+r.bytes,0),unresolved:advice.filter(r=>!r.resolved).length},
    filenameSearches:tools.filter(t=>t.tool==='search_code'&&typeof t.input?.query==='string'&&/\.[a-z0-9]+$/iu.test(t.input.query)).map(t=>({query:t.input.query,mode:t.input.mode,paths:t.output?.data?.results?.filter(r=>r.reason==='path_name').map(r=>r.path)??[]})),
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
    expectedSchemaChange: false,
    sameModelEffortOutputLimit: JSON.stringify([reference.firstContract.model, reference.firstContract.reasoning, reference.firstContract.maximumOutputTokens]) === JSON.stringify([trial.firstContract.model, trial.firstContract.reasoning, trial.firstContract.maximumOutputTokens])});
}
const report = {complete: trials.length === protocol.order.length, executionFinished, interruptedTrials: records.filter(c => c.partial).map(c => c.name), trials, contracts,
  boundary: 'Exact hash/call correlation at the fetch boundary; not proof of remote ingestion, model attention, reasoning or task benefit. Repeated forwarded occurrences are not independent offers. Prompt/schema differences remain visible, never normalized after outcomes. The frozen raw next-command metric includes inspections; this audit separately identifies actual compiler/required validation starts and completions, with one opportunity per observed failed compiler.'};
await atomicJson(join(study, 'mechanism-audit.json'), report);
console.log(JSON.stringify({complete: report.complete, trials: trials.length, contracts}, null, 2));
