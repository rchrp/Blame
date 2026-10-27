// Actual SDK + loopback mock provider; no external model or source solution.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ClineCore} from '../../../packages/agent-runtime/node_modules/@cline/sdk/dist/index.js';
import {lightSemanticHarnessTools} from '../../../packages/agent-runtime/dist/harness/light-tools.js';
import {LightTaskRunner} from '../../../packages/agent-runtime/dist/harness/light-task-runner.js';
import {WorkspaceFiles} from '../../../packages/agent-runtime/dist/harness/workspace-files.js';
import {SessionJournal} from '../../../packages/agent-runtime/dist/harness/session-journal.js';
import {createContextProjectionExtension} from '../../../packages/agent-runtime/dist/context-projection.js';
import {createProviderCompatibleFetch} from '../../../packages/agent-runtime/dist/provider-schema-compatibility.js';
import {appendProductionConfig} from '../../../packages/agent-runtime/dist/production.js';
import {toolPolicies} from '../../../packages/agent-runtime/dist/cline-runtime-configuration.js';
import {unwrapFeedbackEnvelope} from '../../../packages/agent-runtime/dist/tool-result-envelope.js';
import {atomicJson,digest} from '../durable-campaign.mjs';
import {work} from './inputs.mjs';
function parse(value){
 if(typeof value==='string'){try{return parse(JSON.parse(value));}catch{}try{return parse(JSON.parse(value.split('\n')[0]));}catch{return;}}
 if(Array.isArray(value))return unwrapFeedbackEnvelope(value.map(p=>p.type==='input_text'?{...p,type:'text'}:p));
 return value;
}
const reports=[],previous=process.env.BLAME_AGENT_INSPECT_WAIT;
try{for(const enabled of [false,true]){
 process.env.BLAME_AGENT_INSPECT_WAIT=String(enabled);
 const root=await mkdtemp(join(tmpdir(),'inspection-wait-')),session='inspection-'+randomUUID(),requests=[],events=[],controller=new AbortController();
 await mkdir(join(root,'.blame'));await writeFile(join(root,'check.cjs'),"require('node:fs').appendFileSync('.blame/launches','x');setTimeout(()=>console.log('control complete'),8000);\n");
 const runner=new LightTaskRunner({files:new WorkspaceFiles(root),journal:new SessionJournal(root,session),initialCommandWaitMs:0});
 const tools=lightSemanticHarnessTools(root,{executor:async(request,signal)=>{assert.equal(request.tool,'run_task');return runner.run(request.input,{signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal});}}).filter(t=>t.name==='run_task');
 const server=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push(body);
  const last=body.messages.filter(m=>m.role==='tool').at(-1),data=last?parse(last.content)?.data:null;
  const call=!last?{id:'launch',name:'run_task',input:{kind:'command',command:'node check.cjs'}}:data?.completed?null:{id:'inspect-'+requests.length,name:'run_task',input:{kind:'inspect',run:data.run,cursor:data.cursor}};
  const delta=call?{role:'assistant',tool_calls:[{index:0,id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.input)}}]}:{role:'assistant',content:'Control completed.'};
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const chunk of [{id:session,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]},{id:session,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}]}])res.write('data: '+JSON.stringify(chunk)+'\n\n');
  res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const core=await ClineCore.create({backendMode:'local',clientName:'inspection-wait-control',fetch:createProviderCompatibleFetch(globalThis.fetch),toolPolicies:toolPolicies(true)});
 const unsubscribe=await core.subscribe(event=>events.push(event),{sessionId:session});let result,error;
 try{
  try{result=await core.start({prompt:'Execute the supplied requests.',interactive:false,config:appendProductionConfig({sessionId:session,providerId:'openai-compatible',modelId:'offline',apiKey:'local-control',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,cwd:root,workspaceRoot:root,checkpoint:{enabled:false},enableTools:true,enableAgentTeams:false,enableSpawnAgent:false,extraTools:tools,maxIterations:12,systemPrompt:'Execute the supplied tools.',extensions:[createContextProjectionExtension({emit:()=>{},systemPrompt:'Execute the supplied tools.',tools})]})});}catch(e){error=String(e.message??e);}
  const loopGuard=events.some(e=>/Detected 5 consecutive identical calls.*stopping to avoid a loop/u.test(JSON.stringify(e)));
  const outputs=requests.at(-1).messages.filter(m=>m.role==='tool').map(m=>parse(m.content));
  const completed=outputs.find(o=>o?.data?.completed)?.data.completed;
  assert.equal(await readFile(join(root,'.blame/launches'),'utf8'),'x','No relaunch');
  if(enabled){assert.equal(loopGuard,false);assert.equal(result?.result?.text,'Control completed.');assert.equal(completed?.status,'ok');assert.equal(completed.data.exitCode,0);assert.ok(requests.length<=4);}
  else{assert.equal(loopGuard,true,'The fixed quiet command must reproduce the actual SDK guard in the reference');assert.notEqual(result?.result?.text,'Control completed.');}
  const prefixes=requests.slice(1).map(r=>JSON.stringify(r.messages.find(m=>m.role==='tool').content));assert.ok(prefixes.every(v=>v===prefixes[0]),'Previously forwarded result changed');
  reports.push({enabled,localHttpRequests:requests.length,externalModelRequests:0,loopGuard,completedExitCode:completed?.data?.exitCode??null,oneLaunch:true,unchangedForwardedPrefix:true,resultText:result?.result?.text??null,error:error??null,firstToolsSha256:digest(JSON.stringify(requests[0].tools)),firstSystemSha256:digest(JSON.stringify(requests[0].messages.filter(m=>m.role==='system'))),notices:events.filter(e=>/consecutive identical calls/u.test(JSON.stringify(e)))});
 }finally{
  controller.abort();unsubscribe();await core.delete(session).catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  // Finalization can outlive the SDK guard; give the owned run a chance to drain.
  await runner.run({kind:'inspect',run:'r1'}).catch(()=>{});await rm(root,{recursive:true,force:true});
 }
}}
finally{if(previous===undefined)delete process.env.BLAME_AGENT_INSPECT_WAIT;else process.env.BLAME_AGENT_INSPECT_WAIT=previous;}
assert.equal(reports[0].firstToolsSha256,reports[1].firstToolsSha256);assert.equal(reports[0].firstSystemSha256,reports[1].firstSystemSha256);
await atomicJson(join(work,'sdk-controls.json'),{complete:true,actualSdkLoopComparison:true,externalModelRequests:0,reports});
console.log(JSON.stringify(reports,null,2));
