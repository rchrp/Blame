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
 for(const w of wire){assert.equal(w.model,protocol.model);assert.equal(w.reasoning?.effort,protocol.effort);assert.equal(w.maximumOutputTokens,8192);assert.equal(w.byteLimit,500000);assert.equal(sha(read('schema-'+w.toolsSha256+'.json').toString().trimEnd()),w.toolsSha256);assert.equal(sha(read('prompt-'+w.promptSha256+'.json').toString().trimEnd()),w.promptSha256);}
 const d=review.decisions.find(d=>d.name===row.name);assert.deepEqual(d.hashes,row.hashes);assert.equal(d.addedTestsPassed,grade.addedTests.length>0&&grade.deliveredChecks.every(c=>c.exitCode===0));
 const source=row.independentFunctionalSuccess&&d.sourceBehaviorPassed&&d.addedTestsPassed&&d.finalSourceChecksPassed&&d.noSolutionRetrieval;
 assert.equal(row.sourceAuditedCompletion,source);assert.equal(row.auditedCompletion,source&&d.fullRequestPassed);assert.ok(grade.dependencyIntegrity);
}
for(const slot of protocol.order.filter(r=>r.arm==='candidate')){const a=first[`${slot.repeat}-${slot.task}-candidate`],b=first[`${slot.repeat}-${slot.task}-reference`];if(a&&b){assert.equal(a.toolsSha256,b.toolsSha256);assert.equal(a.normalizedContractSha256,b.normalizedContractSha256);}}
const bindings=await json(join(study,'execution-bindings.json')),trees=Object.entries(bindings.files).find(([key])=>key.endsWith('/frozen'))?.[1];assert.ok(trees);
const changed=Object.keys(trees).filter(p=>p.startsWith('candidate/')&&trees[p]!==trees['reference/'+p.slice('candidate/'.length)]).map(p=>p.slice('candidate/agent-runtime/dist/'.length));
assert.deepEqual(changed.sort(),(await json(join(study,'isolation-controls.json'))).changedFiles.slice().sort());
const accounting=reserveTrialCosts(results.rows,wireByTrial,protocol.budgets);assert.deepEqual(accounting,await json(join(study,'accounting.json')));assert.deepEqual(summary.accounting,accounting);
const prior=await json(join(study,'prior-budget.json'));assert.ok(Math.abs(summary.cumulativeAccountedUsd-prior.accountedUsd-accounting.accountedUsd)<1e-8);
for(const arm of protocol.arms){const rows=results.rows.filter(r=>r.arm===arm),s=summary.arms[arm];assert.equal(rows.length,6);assert.equal(s.audited,rows.filter(r=>r.auditedCompletion).length);assert.equal(s.official,rows.filter(r=>r.officialRuntimeSuccess).length);assert.equal(s.selected,rows.filter(r=>r.selectedCheckSuccess).length);assert.equal(s.independent,rows.filter(r=>r.independentFunctionalSuccess).length);for(const [key,target]of [['input','input'],['output','output'],['cost','sdkEstimatedUsd'],['cacheRead','cacheRead'],['cacheWrite','cacheWrite']])assert.equal(s[target],rows.every(r=>r.usage[key]!==null)?rows.reduce((n,r)=>n+r.usage[key],0):null);}
for(const [name,hash]of Object.entries((await json(join(study,'input-archives.json'))).artifacts))assert.equal(sha(await readFile(join(study,'inputs',name))),hash);
assert.equal(summary.qualityGate,summary.arms.candidate.audited>=summary.arms.reference.audited);assert.equal(summary.mechanismGate,summary.arms.candidate.selectionFailureReports>0);
const c=summary.comparisons['candidate/reference'];assert.equal(summary.resourceGate,summary.qualityGate&&c.pairs>=4&&c.tokenDelta!==null&&c.tokenDelta<0&&c.costDelta!==null&&c.costDelta<0&&c.durationDelta!==null&&c.durationDelta<=0.1);
assert.equal(summary.modelBenefitDemonstrated,summary.mechanismGate&&summary.qualityGate&&(summary.arms.candidate.audited>summary.arms.reference.audited||summary.resourceGate));
await save(join(study,'verification.json'),{phase:'F47',trials:18,rawArchiveHashes:true,ledgerAndUsageRecomputed:true,sourceReviewHashBound:true,selectionMechanismRecomputed:true,initialLightPromptSchemaIdentical:true,executableAblationVerified:true,priorReservationsPreserved:true,modelRequests:0});
console.log('F47: 18 immutable traces, receipts, acceptance and executable isolation verified');
