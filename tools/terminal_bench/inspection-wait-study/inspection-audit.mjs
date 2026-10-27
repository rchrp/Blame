// Derived process observations; source/audit success and budgets stay frozen.
import {join} from 'node:path';
import {evidence,file} from './evidence.mjs';
import {study} from './inputs.mjs';
import {atomicJson} from '../durable-campaign.mjs';
const {records,executionFinished}=await evidence();
const trials=records.map(c=>{
 const tools=JSON.parse(file(c,'tool-ledger.json'));
 const events=file(c,'events.jsonl').toString().split('\n').filter(Boolean).map(l=>JSON.parse(l));
 const started=events.filter(r=>r.event.type==='tool'&&r.event.payload.phase==='started'&&r.event.payload.toolCall?.name==='run_task'&&r.event.payload.toolCall.input?.kind==='inspect');
 const inspections=tools.filter(t=>t.tool==='run_task'&&t.input?.kind==='inspect').map(t=>({callId:t.toolCallId??t.toolCall.id,run:t.input.run,inputCursor:t.input.cursor??null,returnedCursor:t.output?.data?.cursor??null,process:t.output?.data?.process??null,outputBytes:Buffer.byteLength(t.output?.data?.output??''),durationMs:t.durationMs??null,finalizedStatus:t.output?.data?.completed?.status??null,exitCode:t.output?.data?.completed?.data?.exitCode??t.output?.data?.exitCode??null}));
 const hard=events.find(r=>r.event.type==='notice'&&/Detected \d+ consecutive identical calls.*stopping to avoid a loop/u.test(r.event.payload?.message??''));
 return {name:c.name,arm:c.row.arm,officialRuntimeSuccess:c.row.officialRuntimeSuccess,sourceSuccess:c.row.sourceSuccess,strictSuccess:c.row.strictSuccess,requiredEvidence:c.row.requiredEvidence,startedInspections:started.length,finishedInspections:inspections.length,incrementalInspections:inspections.filter(t=>t.inputCursor!==null).length,emptyRunningSnapshots:inspections.filter(t=>t.process==='running'&&!t.outputBytes).length,finalizedInspectionResults:inspections.filter(t=>t.finalizedStatus!==null).length,inspections,hardLoopGuardEvent:hard??null};
});
await atomicJson(join(study,'inspection-audit.json'),{executionFinished,trials,boundary:'Actual tool events and outcomes, including inspections started but not finished before a guard abort. Inspection duration includes observation/source/journal overhead, not only internal waiting. Cursor offsets and output bytes are actual data; a last running snapshot does not prove the process was physically running at later termination. No score changes, retries or synthetic completion.'});
console.log('Audited process observations for '+trials.length+' assignments.');
