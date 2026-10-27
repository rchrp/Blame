// Post-dispatch interpretation only; frozen primary scores/counters are retained.
import {join} from 'node:path';import {decode} from '../context-economy-study/required-evidence.mjs';import {evidence,file} from './evidence.mjs';import {study,checksFor,tasks} from './inputs.mjs';import {digest,atomicJson} from '../durable-campaign.mjs';
const {records,executionFinished}=await evidence(),trials=[];
for(const c of records){
 const tools=JSON.parse(file(c,'tool-ledger.json')),events=file(c,'events.jsonl').toString().split('\n').filter(Boolean).map(l=>JSON.parse(l).event);
 const start=new Map(),finish=new Map();events.forEach((e,i)=>{if(e.type==='tool')(e.payload.phase==='started'?start:finish).set(e.payload.toolCallId??e.payload.toolCall?.id,i);});
 const jsonl=name=>file(c,name).toString().split('\n').filter(Boolean).map(l=>JSON.parse(l)),queues=new Map(),observed=[];
 for(const receipt of jsonl('receipt-metadata.jsonl')){const q=queues.get(receipt.requestBodySha256)??[];q.push(receipt);queues.set(receipt.requestBodySha256,q);}
 for(const wire of jsonl('wire-contracts.jsonl')){const receipt=queues.get(wire.requestBodySha256)?.shift();if(receipt&&!wire.budgetRejected)observed.push(...(receipt.declarations??[]));}
 const offers=[],seen=new Set();
 for(const t of tools){
  if(t.tool!=='search_code'||t.output?.status!=='ok')continue;const d=t.output.data,id=t.toolCallId??t.toolCall?.id,primary=d.results??[],before=finish.get(id)??Infinity;
  for(const candidate of d.declarationCandidates??[]){
   const key=candidate.path+'#'+candidate.qualifiedName,keys=new Set([candidate.target,candidate.alias].filter(Boolean));
   const reads=tools.filter(r=>r.tool==='read_code'&&r.output?.status==='ok'&&keys.has(r.input?.target)&&(start.get(r.toolCallId??r.toolCall?.id)??-1)>before&&r.output?.data?.path===candidate.path&&r.output?.data?.qualifiedName===candidate.qualifiedName);
   offers.push({query:t.input.query,path:candidate.path,qualifiedName:candidate.qualifiedName,absentFromThisPrimaryResult:!primary.some(p=>p.path===candidate.path&&p.qualifiedName===candidate.qualifiedName),absentFromEarlierStructuredSearchResults:!seen.has(key),matchingCandidateMetadataObserved:observed.some(o=>o.callIdSha256===digest(id)&&o.candidates.some(v=>v.path===candidate.path&&v.qualifiedName===candidate.qualifiedName&&v.targetSha256===digest(candidate.target))),successfulSubsequentReads:reads.map(r=>({callId:r.toolCallId??r.toolCall?.id,usingAlias:r.input.target===candidate.alias,usingQualifiedTarget:r.input.target===candidate.target}))});
  }
  for(const item of [...primary,...(d.declarationCandidates??[])])if(item.path&&item.qualifiedName)seen.add(item.path+'#'+item.qualifiedName);
 }
 const required=new Set(checksFor(tasks.find(t=>t.id===c.row.task)).map(x=>'npm run '+x.task)),runs=new Map();let lastFinish=null;
 for(const e of events){
  const p=e.payload;if(e.type!=='tool')continue;
  if(p.phase==='finished'&&p.toolCall?.name==='run_task'){
   const output=decode(p.output),d=output?.status==='ok'?output.data:null;if(!d||typeof d.run!=='string')continue;
   const completed=d.completed?.status==='ok'?d.completed.data:null;
   runs.set(d.run,{run:d.run,command:d.command,process:d.process??null,observedExitCode:completed?.exitCode??d.exitCode??null,completedPayload:!!completed,lastObservationCallId:p.toolCallId??p.toolCall.id});
  }
  if(p.phase==='started'&&p.toolCall?.name==='finish_task')lastFinish={callId:p.toolCallId??p.toolCall.id,unconfirmedRequiredRuns:[...runs.values()].filter(r=>required.has(r.command)&&r.observedExitCode===null)};
 }
 trials.push({name:c.name,arm:c.row.arm,task:c.row.task,repeat:c.row.repeat,offers,lastAttemptedFinish:lastFinish});
}
await atomicJson(join(study,'supplemental-audits.json'),{executionFinished,trials,boundary:'Derived sensitivity, not a change to frozen primary scores. Equivalent alias and qualified-target reads are counted separately; primary-result overlap is explicit, so a read does not prove candidate adoption or causal benefit. Candidate metadata was observed, but alias fields are not independently attested by the compact receipt. Pending-run records describe the last observed snapshot, not the physical state at finish or a passing outcome.'});
console.log('Audited '+trials.length+' completed transcripts without changing scores.');
