// Read-only interpretation of recorded events; no score changes or model retries.
import {join,resolve} from 'node:path';
import {evidence,file} from './evidence.mjs';
import {study} from './inputs.mjs';
import {atomicJson,digest} from '../durable-campaign.mjs';
const arg=process.argv.indexOf('--study');
const directory=arg>=0?resolve(process.argv[arg+1]):study;
const {protocolHash,records,executionFinished}=await evidence({directory});
const trials=records.map(c=>{
 const events=file(c,'events.jsonl').toString().split('\n').filter(Boolean).map(l=>JSON.parse(l));
 const messages=events.filter(r=>['notice','error'].includes(r.event.type)&&typeof r.event.payload?.message==='string');
 const loops=messages.filter(r=>/Detected \d+ consecutive identical calls/u.test(r.event.payload.message));
 const hard=loops.find(r=>r.event.payload.message.includes('stopping to avoid a loop'));
 const limit=messages.find(r=>/exceeded maxIterations/u.test(r.event.payload.message));
 const tools=JSON.parse(file(c,'tool-ledger.json'));
 return {name:c.name,officialRuntimeSuccess:c.row.officialRuntimeSuccess,sourceSuccess:c.row.sourceSuccess,strictSuccess:c.row.strictSuccess,
  iterationStartEvents:events.filter(r=>r.event.payload?.message==='Agent iteration started.').length,
  observedStop:hard?'sdk_identical_call_guard':limit?'max_iterations':c.row.officialRuntimeSuccess?'official_completion':'other_or_unknown',
  explanatoryEvent:hard??limit??null,
  lastCompletedTools:tools.slice(-6).map(t=>({callId:t.toolCallId??t.toolCall?.id,tool:t.tool,input:t.input,inputSha256:digest(JSON.stringify(t.input??null)),timestamp:t.timestamp,status:t.output?.status??null,process:t.output?.data?.process??null,hasFinalizedPayload:!!t.output?.data?.completed,exitCode:t.output?.data?.exitCode??null})),
 };
});
await atomicJson(join(directory,'termination-audit.json'),{protocolHash,executionFinished,trials,boundary:'Observed stop reasons from actual SDK notices, never inferred solely from configured limits. Last tool snapshots are observations, not proof of physical process state at termination. The immutable primary completion/source/audit scores and resource totals are unchanged.'});
console.log('Recorded actual stop reasons for '+trials.length+' assignments.');
