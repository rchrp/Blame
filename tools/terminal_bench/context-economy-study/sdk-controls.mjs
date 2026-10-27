import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {ClineCore} from '../../../packages/agent-runtime/node_modules/@cline/sdk/dist/index.js';
import {lightSemanticHarnessTools} from '../../../packages/agent-runtime/dist/harness/light-tools.js';
import {createContextProjectionExtension} from '../../../packages/agent-runtime/dist/context-projection.js';
import {createProviderCompatibleFetch} from '../../../packages/agent-runtime/dist/provider-schema-compatibility.js';
import {appendProductionConfig} from '../../../packages/agent-runtime/dist/production.js';
import {toolPolicies} from '../../../packages/agent-runtime/dist/cline-runtime-configuration.js';
import {unwrapFeedbackEnvelope} from '../../../packages/agent-runtime/dist/tool-result-envelope.js';
import {atomicJson} from '../durable-campaign.mjs';
import {work} from './inputs.mjs';
import {adviceMetadata} from './advice-metadata.mjs';
function parse(value){
 if(typeof value==='string'){try{return parse(JSON.parse(value));}catch{}try{return parse(JSON.parse(value.split('\n')[0]));}catch{return;}}
 if(Array.isArray(value))return unwrapFeedbackEnvelope(value.map(p=>p.type==='input_text'?{...p,type:'text'}:p));
 return value;
}
function plan(output){const r=parse(output);if(r?.data?.validationRepair)return r.data.validationRepair;try{return JSON.parse(r?.recovery?.split('\n').at(-1)).validationRepair;}catch{return;}}
const reports=[],previous=process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION;
try{for(const enabled of [false,true]){
 process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION=String(enabled);
 const root=await mkdtemp(join(tmpdir(),'context-advice-')),session='advice-'+randomUUID(),requests=[];
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'node --test suite.cjs'}}));
 await writeFile(join(root,'suite.cjs'),"require('node:test').test('known failure',()=>require('node:assert/strict').equal(1,2));\n");
 const tools=lightSemanticHarnessTools(root,{taskContract:{session_id:session}}).filter(t=>['run_task','read_code'].includes(t.name));
 const calls=[{id:'failure',name:'run_task',input:{kind:'project',task:'test'}},{id:'inspection',name:'run_task',input:{kind:'command',command:'pwd'}},{id:'explicit-ledger',name:'read_code',input:{target:'@checks'}}];
 const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push(JSON.parse(raw));const call=calls[requests.length-1];
 const delta=call?{role:'assistant',tool_calls:[{index:0,id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.input)}}]}:{role:'assistant',content:'Control completed.'};
 res.writeHead(200,{'content-type':'text/event-stream'});for(const chunk of [{id:session,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]},{id:session,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}]}])res.write('data: '+JSON.stringify(chunk)+'\n\n');res.end('data: [DONE]\n\n');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const core=await ClineCore.create({backendMode:'local',clientName:'advice-transport-control',fetch:createProviderCompatibleFetch(globalThis.fetch),toolPolicies:toolPolicies(true)});
 try{
  const result=await core.start({prompt:'Execute the supplied requests.',interactive:false,config:appendProductionConfig({sessionId:session,providerId:'openai-compatible',modelId:'offline',apiKey:'local-control',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,cwd:root,workspaceRoot:root,checkpoint:{enabled:false},enableTools:true,enableAgentTeams:false,enableSpawnAgent:false,extraTools:tools,maxIterations:5,systemPrompt:'Execute the supplied tools.',extensions:[createContextProjectionExtension({emit:()=>{},systemPrompt:'Execute the supplied tools.',tools})]})});
  assert.equal(result.result?.text,'Control completed.');assert.equal(requests.length,4);
  const outputs=requests[3].messages.filter(m=>m.role==='tool'),plans=outputs.map(m=>plan(m.content));
  assert.equal(plans.length,3);assert.ok(plans[0]?.repairFirst?.length);assert.ok(plans[2]?.repairFirst?.length);
  assert.equal(plans[1]?.kind,enabled?'repair_plan_reference':undefined);
  const first=requests.slice(1).map(r=>JSON.stringify(r.messages.find(m=>m.role==='tool').content));assert.ok(first.every(v=>v===first[0]),'Previously forwarded tool content changed');
  assert.equal(parse(outputs[0].content)?.data?.check?.outcome,'failed');
  const received=adviceMetadata(requests[3]);assert.equal(received.length,3);assert.ok(received.every(r=>r.resolved));
  reports.push({enabled,localHttpRequests:requests.length,externalModelRequests:0,kinds:plans.map(p=>p.kind??'full'),adviceChars:plans.map(p=>JSON.stringify(p).length),actualObserverReceipts:received,firstToolContentSha256:createHash('sha256').update(first[0]).digest('hex'),unchangedForwardedPrefix:true,failedCheckStillFailed:true,explicitChecksRestoresFull:true});
 }finally{await core.delete(session).catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
}}
finally{if(previous===undefined)delete process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION;else process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION=previous;}
await atomicJson(join(work,'sdk-controls.json'),{externalModelRequests:0,reports});console.log(JSON.stringify(reports,null,2));
