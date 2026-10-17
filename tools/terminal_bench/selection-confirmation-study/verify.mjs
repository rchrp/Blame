// Recompute original receipts, acceptance, isolation and summaries from public artifacts.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {join} from 'node:path';
import {study,json,sha,save} from './setup.mjs';
import {reconcileUsage} from '../corpus/light-study-accounting.mjs';
import {reserveTrialCosts} from '../navigation-evidence/budget-accounting.mjs';
const protocol=await json(join(study,'protocol.json')),results=await json(join(study,'results.json')),summary=await json(join(study,'summary.json')),review=await json(join(study,'source-review.json'));
assert.equal(protocol.order.length,18);assert.equal(results.rows.length,18);assert.equal(review.decisions.length,18);
assert.deepEqual(results.rows.map(r=>r.name),protocol.order.map(r=>`${r.repeat}-${r.task}-${r.arm}`));
const wireByTrial={},first={};
for(const row of results.rows){
 const bytes=await readFile(join(study,'traces',row.name+'.json.gz'));assert.equal(sha(bytes),row.traceSha256);const archive=JSON.parse(gunzipSync(bytes));assert.equal(archive.name,row.name);
 const read=name=>{const f=archive.files[name];assert.ok(f,name);const b=Buffer.from(f.base64,'base64');assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);return b;};
 for(const name of Object.keys(archive.files))read(name);for(const [name,hash]of Object.entries(row.hashes))assert.equal(sha(read(name)),hash);
 assert.equal(read('instruction.txt').toString(),protocol.tasks.find(t=>t.id===row.task).instruction);assert.deepEqual(JSON.parse(read('required-checks.json')),protocol.tasks.find(t=>t.id===row.task).requiredChecks);
 const grade=JSON.parse(read('score.json')),raw=archive.files['result.json']?JSON.parse(read('result.json')):{},exit=JSON.parse(read('model-exit.json'));
 assert.equal(row.officialRuntimeSuccess,raw.status==='succeeded');assert.deepEqual(row.exit,exit);assert.equal(row.durationMs,raw.durationMs??exit.durationMs);
 assert.equal(row.independentFunctionalSuccess,grade.protectedPaths.length===0&&grade.checks.every(c=>c.exitCode===0));
 assert.equal(row.selectedCheckSuccess,grade.protectedPaths.length===0&&grade.checks.filter(c=>c.name!=='feature').every(c=>c.exitCode===0)&&grade.deliveredChecks.find(c=>c.name==='delivered')?.exitCode===0);
 const finishLedger=JSON.parse(read('tool-ledger.json'));assert.equal(row.observedFinishRejections,finishLedger.filter(t=>t.tool==='finish_task'&&t.output&&typeof t.output==='object'&&['blocked','failed'].includes(t.output.status)).length);assert.equal(row.successfulFinishStrings,finishLedger.filter(t=>t.tool==='finish_task'&&typeof t.output==='string').length);
 const events=read('events.jsonl').toString().trim().split('\n').filter(Boolean).map(JSON.parse).map(r=>r.event);
 let iteration=0;const ledger=[],starts=new Map();
 for(const [index,event]of events.entries()){
  if(event.type==='notice'&&event.payload?.message==='Agent iteration started.')iteration++;
  if(event.type==='tool'&&event.payload?.phase==='started')starts.set(event.payload.toolCallId??event.payload.toolCall?.id,index);
  if(event.type==='tool'&&event.payload?.phase==='finished')ledger.push({...event.payload,observedIteration:iteration,observedStartIndex:starts.get(event.payload.toolCallId??event.payload.toolCall?.id)??null,tool:event.payload.toolCall?.name??event.payload.tool,input:event.payload.toolCall?.input??event.payload.input});
 }
 assert.deepEqual(JSON.parse(read('tool-ledger.json')),ledger);
 const selections=ledger.flatMap((tool,index)=>{const data=tool.output?.data?.completed?.data??tool.output?.data;return tool.tool==='run_task'&&data?.check?.selectionFailure==='no_test_files'?[{index,observedIteration:tool.observedIteration,command:data.command,check:data.check,recovery:tool.output.recovery??null}]:[];});
 assert.deepEqual(row.selectionFailures,selections);assert.equal(row.noTestFileOutputs,ledger.filter(t=>/No test files found, exiting with code 1/.test(JSON.stringify(t.output))).length);assert.equal(row.finishFailures,ledger.filter(t=>t.tool==='finish_task'&&t.output?.status!=='ok').length);
 if(row.arm==='reference')assert.equal(selections.length,0);
 const usage=reconcileUsage(raw.usage,events.filter(e=>e.type==='usage').map(e=>e.payload?.usage),iteration);assert.deepEqual(row.usage,usage);
 const wire=archive.files['wire-contracts.jsonl']?read('wire-contracts.jsonl').toString().trim().split('\n').filter(Boolean).map(JSON.parse):[];wireByTrial[row.name]=wire;first[row.name]=wire.find(w=>!w.budgetRejected);
 const forwarded=wire.filter(w=>!w.budgetRejected).length;
 assert.equal(row.contract.forwarded,forwarded);assert.equal(row.contract.usageReports,usage.reports);assert.equal(row.contract.unreported,Math.max(0,forwarded-usage.reports));
 for(const w of wire){assert.equal(w.model,protocol.model);assert.equal(w.reasoning?.effort,protocol.effort);assert.equal(w.maximumOutputTokens,8192);assert.equal(w.byteLimit,500000);assert.equal(sha(read('schema-'+w.toolsSha256+'.json').toString().trimEnd()),w.toolsSha256);assert.equal(sha(read('prompt-'+w.promptSha256+'.json').toString().trimEnd()),w.promptSha256);}
 const d=review.decisions.find(d=>d.name===row.name);assert.deepEqual(d.hashes,row.hashes);assert.equal(d.addedTestsPassed,grade.addedTests.length>0&&grade.deliveredChecks.every(c=>c.exitCode===0));
 for(const key of ['sourceBehaviorPassed','addedTestsPassed','finalSourceChecksPassed','noSolutionRetrieval','fullRequestPassed'])assert.equal(typeof d[key],'boolean',row.name+': '+key);
 assert.ok(Array.isArray(d.evidence)&&d.evidence.length>0,'Explicit source/delivery review evidence required');
 const source=row.independentFunctionalSuccess&&d.sourceBehaviorPassed&&d.addedTestsPassed&&d.finalSourceChecksPassed&&d.noSolutionRetrieval;
 assert.equal(row.sourceAuditedCompletion,source);assert.equal(row.auditedCompletion,source&&d.fullRequestPassed);assert.ok(grade.dependencyIntegrity);
}
for(const slot of protocol.order.filter(r=>r.arm==='candidate')){const a=first[`${slot.repeat}-${slot.task}-candidate`],b=first[`${slot.repeat}-${slot.task}-reference`];if(a&&b){assert.equal(a.toolsSha256,b.toolsSha256);assert.equal(a.normalizedContractSha256,b.normalizedContractSha256);}}
const bindings=await json(join(study,'execution-bindings.json')),trees=Object.entries(bindings.files).find(([key])=>key.endsWith('/frozen'))?.[1];assert.ok(trees);
const changed=Object.keys(trees).filter(p=>p.startsWith('candidate/')&&trees[p]!==trees['reference/'+p.slice('candidate/'.length)]).map(p=>p.slice('candidate/agent-runtime/dist/'.length));
assert.deepEqual(changed.sort(),(await json(join(study,'isolation-controls.json'))).changedFiles.slice().sort());
const accounting=reserveTrialCosts(results.rows,wireByTrial,protocol.budgets);assert.deepEqual(accounting,await json(join(study,'accounting.json')));assert.deepEqual(summary.accounting,accounting);
const prior=await json(join(study,'prior-budget.json'));assert.ok(Math.abs(summary.cumulativeAccountedUsd-prior.accountedUsd-accounting.accountedUsd)<1e-8);
assert.equal(summary.priorObservedUsd,prior.observedUsd);assert.equal(summary.priorReservedUsd,prior.reservedUsd);
assert.ok(Math.abs(summary.cumulativeObservedSdkUsd-prior.observedUsd-accounting.observedUsd)<1e-8);
assert.ok(Math.abs(summary.cumulativeReservedUsd-prior.reservedUsd-accounting.reservedUsd)<1e-8);
// Unbound measurement amendment: derive publication arithmetic from checked raw
// rows independently; no publisher import, changed acceptance rule or model retry.
const sum=values=>values.every(Number.isFinite)?values.reduce((a,b)=>a+b,0):null;
const ratio=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b!==0?(a-b)/b:null;
const tokenCount=row=>Number.isFinite(row.usage.input)&&Number.isFinite(row.usage.output)?row.usage.input+row.usage.output:null;
const comparable=row=>row.contract.unreported===0&&row.usage.tokensCostReconciled&&tokenCount(row)!==null&&Number.isFinite(row.usage.cost);
function same(actual,expected,label){
 if(typeof expected==='number'){
  assert.equal(typeof actual,'number',label);assert.ok(Number.isFinite(actual),label);
  assert.ok(Math.abs(actual-expected)<=Math.max(1e-12,Math.abs(expected)*1e-12),label+': '+actual+' != '+expected);return;
 }
 if(expected===null||typeof expected!=='object'){assert.equal(actual,expected,label);return;}
 assert.ok(actual&&typeof actual==='object',label);assert.equal(Array.isArray(actual),Array.isArray(expected),label);
 assert.deepEqual(Object.keys(actual).sort(),Object.keys(expected).sort(),label);
 for(const key of Object.keys(expected))same(actual[key],expected[key],label+'.'+key);
}
for(const arm of protocol.arms){
 const rows=results.rows.filter(r=>r.arm===arm),count=predicate=>rows.filter(predicate).length;
 assert.equal(rows.length,6);
 const input=sum(rows.map(r=>r.usage.input)),output=sum(rows.map(r=>r.usage.output));
 same(summary.arms[arm],{trials:rows.length,official:count(r=>r.officialRuntimeSuccess),selected:count(r=>r.selectedCheckSuccess),independent:count(r=>r.independentFunctionalSuccess),audited:count(r=>r.auditedCompletion),sourceAudited:count(r=>r.sourceAuditedCompletion),input,output,tokens:input===null||output===null?null:input+output,
  cacheRead:sum(rows.map(r=>r.usage.cacheRead)),cacheWrite:sum(rows.map(r=>r.usage.cacheWrite)),sdkEstimatedUsd:sum(rows.map(r=>r.usage.cost)),durationMs:sum(rows.map(r=>r.durationMs)),forwardedRequests:sum(rows.map(r=>r.contract.forwarded)),missingUsageReceipts:sum(rows.map(r=>r.contract.unreported)),cachePerRequestReconciled:rows.every(r=>r.usage.reconciliation.cacheRead.matches&&r.usage.reconciliation.cacheWrite.matches),emptySelectionTrials:count(r=>r.noTestFileOutputs>0),selectionFailureReports:sum(rows.map(r=>r.selectionFailures.length)),finishFailures:sum(rows.map(r=>r.finishFailures)),observedFinishRejections:sum(rows.map(r=>r.observedFinishRejections)),successfulFinishStrings:sum(rows.map(r=>r.successfulFinishStrings))},'arms.'+arm);
}
function verifyComparisons(field,eligible){
 const panel=summary[field];assert.deepEqual(Object.keys(panel).sort(),['candidate/cline','candidate/reference']);
 for(const baselineArm of ['reference','cline']){
  const pairs=results.rows.filter(r=>r.arm==='candidate'&&eligible(r)).flatMap(candidate=>{
   const baseline=results.rows.find(r=>r.arm===baselineArm&&r.repeat===candidate.repeat&&r.task===candidate.task&&eligible(r));
   return baseline?[{candidate,baseline}]:[];
  });
  const totals=side=>{const rows=pairs.map(p=>p[side]),known=rows.every(comparable);return{trials:rows.length,tokens:known?sum(rows.map(tokenCount)):null,cost:known?sum(rows.map(r=>r.usage.cost)):null,durationMs:sum(rows.map(r=>r.durationMs))};};
  const candidate=totals('candidate'),baseline=totals('baseline');
  const detail=pairs.map(p=>({task:p.candidate.task,repeat:p.candidate.repeat,candidate:p.candidate.name,baseline:p.baseline.name,tokenDelta:comparable(p.candidate)&&comparable(p.baseline)?ratio(tokenCount(p.candidate),tokenCount(p.baseline)):null,costDelta:ratio(p.candidate.usage.cost,p.baseline.usage.cost),durationDelta:ratio(p.candidate.durationMs,p.baseline.durationMs)}));
  // Unknown pair evidence never becomes zero in a sensitivity subtotal.
  const sensitivity=kept=>kept.every(p=>comparable(p.candidate)&&comparable(p.baseline)&&tokenCount(p.baseline)!==0)
   ?ratio(sum(kept.map(p=>tokenCount(p.candidate))),sum(kept.map(p=>tokenCount(p.baseline)))):null;
  const expected={pairs:pairs.length,candidate,baseline,tokenDelta:ratio(candidate.tokens,baseline.tokens),costDelta:ratio(candidate.cost,baseline.cost),durationDelta:ratio(candidate.durationMs,baseline.durationMs),pairDetails:detail,
   byTask:protocol.tasks.map(t=>{const kept=pairs.filter(p=>p.candidate.task===t.id);return{task:t.id,pairs:kept.length,tokenDelta:sensitivity(kept)};}),
   leaveOnePairOut:pairs.map(p=>({omitted:p.candidate.name,tokenDelta:sensitivity(pairs.filter(q=>q!==p))})),
   leaveOneTaskOut:protocol.tasks.map(t=>({omitted:t.id,tokenDelta:sensitivity(pairs.filter(p=>p.candidate.task!==t.id))}))};
  same(panel['candidate/'+baselineArm],expected,field+'.candidate/'+baselineArm);
 }
}
verifyComparisons('comparisons',r=>r.auditedCompletion);
verifyComparisons('selectedComparisons',r=>r.selectedCheckSuccess);
verifyComparisons('functionalComparisons',r=>r.independentFunctionalSuccess);
assert.deepEqual(Object.keys(summary.allAssignedComparisons).sort(),['candidate/cline','candidate/reference']);
for(const other of ['reference','cline']){
 const observed=summary.allAssignedComparisons['candidate/'+other],a=summary.arms.candidate,b=summary.arms[other];
 assert.equal(typeof observed.caveat,'string');
 const {caveat,...actual}=observed;void caveat;
 same(actual,{assignmentsPerArm:a.trials,candidateAudited:a.audited,baselineAudited:b.audited,tokenDelta:ratio(a.tokens,b.tokens),costDelta:ratio(a.sdkEstimatedUsd,b.sdkEstimatedUsd),durationDelta:ratio(a.durationMs,b.durationMs)},'allAssignedComparisons.candidate/'+other);
}
const amendment=await json(join(study,'measurement-amendment.json'));
assert.equal(amendment.frozenDriverChanged,false);assert.equal(amendment.acceptanceCriteriaChanged,false);
assert.ok(Number.isFinite(Date.parse(amendment.recordedAtUTC)));
assert.deepEqual(amendment.completedAtDiscovery,protocol.order.slice(0,amendment.completedAtDiscovery.length).map(r=>`${r.repeat}-${r.task}-${r.arm}`));
for(const [name,hash]of Object.entries((await json(join(study,'input-archives.json'))).artifacts))assert.equal(sha(await readFile(join(study,'inputs',name))),hash);
assert.equal(summary.qualityGate,summary.arms.candidate.audited>=summary.arms.reference.audited);assert.equal(summary.mechanismGate,summary.arms.candidate.selectionFailureReports>0);
const c=summary.comparisons['candidate/reference'];assert.equal(summary.resourceGate,summary.qualityGate&&c.pairs>=4&&c.tokenDelta!==null&&c.tokenDelta<0&&c.costDelta!==null&&c.costDelta<0&&c.durationDelta!==null&&c.durationDelta<=0.1);
assert.equal(summary.modelBenefitDemonstrated,summary.mechanismGate&&summary.qualityGate&&(summary.arms.candidate.audited>summary.arms.reference.audited||summary.resourceGate));
await save(join(study,'verification.json'),{phase:'F47',trials:18,rawArchiveHashes:true,ledgerAndUsageRecomputed:true,sourceReviewHashBound:true,selectionMechanismRecomputed:true,finishMeasurementAmendmentVerified:true,allSummaryComparisonsIndependentlyRecomputed:true,missingUsageSensitivityPreserved:true,initialLightPromptSchemaIdentical:true,executableAblationVerified:true,priorReservationsPreserved:true,modelRequests:0});
console.log('F47: 18 immutable traces, receipts, acceptance and executable isolation verified');
