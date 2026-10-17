// Publish every assigned outcome. Official, selected and audited success remain separate.
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {mkdir,readFile,readdir,writeFile,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {work,study,json,sha,save} from './setup.mjs';
const protocol=await json(join(study,'protocol.json')),analysis=await json(join(work,'campaign/analysis.json')),exit=await json(join(work,'campaign/driver-exit.json'));
assert.equal(exit.complete,true);assert.equal(analysis.rows.length,protocol.order.length);
const review=await json(join(study,'source-review.json'));assert.equal(review.decisions.length,analysis.rows.length);
await mkdir(join(study,'traces'),{recursive:true});const rows=[];
for(const raw of analysis.rows){
 const decision=review.decisions.find(d=>d.name===raw.name);assert.ok(decision);assert.deepEqual(decision.hashes,raw.hashes);
 for(const key of ['sourceBehaviorPassed','addedTestsPassed','finalSourceChecksPassed','noSolutionRetrieval','fullRequestPassed'])assert.equal(typeof decision[key],'boolean',raw.name+': '+key);
 assert.ok(Array.isArray(decision.evidence)&&decision.evidence.length>0,'Explicit review evidence required');
 const directory=join(work,'campaign',raw.name),files={};
 for(const entry of await readdir(directory,{withFileTypes:true})){
  if(!entry.isFile()||['workspace.tar.gz','generated-caches.tar.gz'].includes(entry.name))continue;
  const bytes=await readFile(join(directory,entry.name));
  for(const [key,value]of Object.entries(process.env))if(/(?:TOKEN|SECRET|PASSWORD|API_KEY)$/.test(key)&&value.length>=16)assert.ok(!bytes.includes(Buffer.from(value)),'Configured credential found; refuse public output');
  files[entry.name]={bytes:bytes.length,sha256:sha(bytes),base64:bytes.toString('base64')};
 }
 const archive=gzipSync(JSON.stringify({name:raw.name,files}),{mtime:0});await writeFile(join(study,'traces',raw.name+'.json.gz'),archive);
 const source=raw.independentFunctionalSuccess&&decision.sourceBehaviorPassed&&decision.addedTestsPassed&&decision.finalSourceChecksPassed&&decision.noSolutionRetrieval;
 rows.push({...raw,sourceAuditedCompletion:source,auditedCompletion:source&&decision.fullRequestPassed,traceSha256:sha(archive)});
}
const sum=(rows,key)=>rows.every(r=>r.usage[key]!==null)?rows.reduce((n,r)=>n+r.usage[key],0):null;
const arms=Object.fromEntries(protocol.arms.map(arm=>{const selected=rows.filter(r=>r.arm===arm),input=sum(selected,'input'),output=sum(selected,'output');return [arm,{trials:selected.length,official:selected.filter(r=>r.officialRuntimeSuccess).length,selected:selected.filter(r=>r.selectedCheckSuccess).length,independent:selected.filter(r=>r.independentFunctionalSuccess).length,audited:selected.filter(r=>r.auditedCompletion).length,sourceAudited:selected.filter(r=>r.sourceAuditedCompletion).length,input,output,tokens:input===null||output===null?null:input+output,cacheRead:sum(selected,'cacheRead'),cacheWrite:sum(selected,'cacheWrite'),sdkEstimatedUsd:sum(selected,'cost'),durationMs:selected.every(r=>Number.isFinite(r.durationMs))?selected.reduce((n,r)=>n+r.durationMs,0):null,forwardedRequests:selected.reduce((n,r)=>n+r.contract.forwarded,0),missingUsageReceipts:selected.reduce((n,r)=>n+r.contract.unreported,0),cachePerRequestReconciled:selected.every(r=>r.usage.reconciliation.cacheRead.matches&&r.usage.reconciliation.cacheWrite.matches),emptySelectionTrials:selected.filter(r=>r.noTestFileOutputs>0).length,selectionFailureReports:selected.reduce((n,r)=>n+r.selectionFailures.length,0),finishFailures:selected.reduce((n,r)=>n+r.finishFailures,0)}];}));
const delta=(a,b)=>a===null||b===null||b===0?null:a/b-1;
function compare(predicate){return Object.fromEntries(['reference','cline'].map(other=>{
 const selected=rows.filter(r=>r.arm==='candidate'&&predicate(r)&&rows.some(b=>b.arm===other&&b.repeat===r.repeat&&b.task===r.task&&predicate(b)));
 const totals=arm=>{const pair=selected.map(r=>rows.find(b=>b.arm===arm&&b.repeat===r.repeat&&b.task===r.task)),known=pair.every(r=>r.contract.unreported===0&&r.usage.tokensCostReconciled);return {trials:pair.length,tokens:known?pair.reduce((n,r)=>n+r.usage.input+r.usage.output,0):null,cost:known?pair.reduce((n,r)=>n+r.usage.cost,0):null,durationMs:pair.every(r=>Number.isFinite(r.durationMs))?pair.reduce((n,r)=>n+r.durationMs,0):null};};
 const candidate=totals('candidate'),baseline=totals(other);
 const pairDetails=selected.map(r=>{const b=rows.find(b=>b.arm===other&&b.repeat===r.repeat&&b.task===r.task);return {task:r.task,repeat:r.repeat,candidate:r.name,baseline:b.name,tokenDelta:r.contract.unreported===0&&b.contract.unreported===0?delta(r.usage.input+r.usage.output,b.usage.input+b.usage.output):null,costDelta:delta(r.usage.cost,b.usage.cost),durationDelta:delta(r.durationMs,b.durationMs)};});
 const subsetDelta=kept=>{const total=arm=>kept.reduce((n,p)=>{const r=rows.find(r=>r.arm===arm&&r.repeat===p.repeat&&r.task===p.task);return n+r.usage.input+r.usage.output;},0);return kept.every(p=>p.tokenDelta!==null)?delta(total('candidate'),total(other)):null;};
 return ['candidate/'+other,{pairs:selected.length,candidate,baseline,tokenDelta:delta(candidate.tokens,baseline.tokens),costDelta:delta(candidate.cost,baseline.cost),durationDelta:delta(candidate.durationMs,baseline.durationMs),pairDetails,byTask:protocol.tasks.map(t=>({task:t.id,pairs:pairDetails.filter(p=>p.task===t.id).length,tokenDelta:subsetDelta(pairDetails.filter(p=>p.task===t.id))})),leaveOnePairOut:pairDetails.map(p=>({omitted:p.candidate,tokenDelta:subsetDelta(pairDetails.filter(q=>q!==p))})),leaveOneTaskOut:protocol.tasks.map(t=>({omitted:t.id,tokenDelta:subsetDelta(pairDetails.filter(p=>p.task!==t.id))}))}];
 }));}
const comparisons=compare(r=>r.auditedCompletion),selectedComparisons=compare(r=>r.independentFunctionalSuccess);
const allAssignedComparisons=Object.fromEntries(['reference','cline'].map(other=>['candidate/'+other,{assignmentsPerArm:arms.candidate.trials,candidateAudited:arms.candidate.audited,baselineAudited:arms[other].audited,tokenDelta:delta(arms.candidate.tokens,arms[other].tokens),costDelta:delta(arms.candidate.sdkEstimatedUsd,arms[other].sdkEstimatedUsd),durationDelta:delta(arms.candidate.durationMs,arms[other].durationMs),caveat:'Every assigned failure is retained. Unequal audited quality is not efficiency at quality parity.'}]));
const qualityGate=arms.candidate.audited>=arms.reference.audited,mechanismGate=arms.candidate.selectionFailureReports>0,c=comparisons['candidate/reference'];
const resourceGate=qualityGate&&c.pairs>=protocol.criteria.minimumPairedSuccesses&&c.tokenDelta!==null&&c.tokenDelta<0&&c.costDelta!==null&&c.costDelta<0&&c.durationDelta!==null&&c.durationDelta<=0.1;
const accounting=await json(join(work,'campaign/accounting.json')),prior=await json(join(study,'prior-budget.json'));
await save(join(study,'results.json'),{phase:'F47',planned:protocol.order.length,completed:rows.length,rows});
await cp(join(work,'campaign/accounting.json'),join(study,'accounting.json'));await cp(join(work,'campaign/driver-exit.json'),join(study,'driver-exit.json'));
await save(join(study,'summary.json'),{phase:'F47',complete:true,arms,comparisons,selectedComparisons,allAssignedComparisons,qualityGate,mechanismGate,resourceGate,modelBenefitDemonstrated:mechanismGate&&qualityGate&&(arms.candidate.audited>arms.reference.audited||resourceGate),accounting,priorObservedUsd:prior.observedUsd,priorReservedUsd:prior.reservedUsd,cumulativeObservedSdkUsd:prior.observedUsd+accounting.observedUsd,cumulativeReservedUsd:prior.reservedUsd+accounting.reservedUsd,cumulativeAccountedUsd:prior.accountedUsd+accounting.accountedUsd,limitations:'Three new requests on a small constructed monorepo, two dependent repetitions, no injected empty selector. Unblinded source/delivery review. Provider revision, seeds, hidden retries, host contention and invoices unknown. Tokens include cache reads; SDK estimates are not invoices, missing receipts remain missing. No observed mechanism use means no demonstrated recovery benefit; an unverified finish is not task correctness. Campaigns remain separate.'});
console.log(JSON.stringify({arms,qualityGate,mechanismGate,resourceGate}));
