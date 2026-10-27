// Real SDK loop and provider serializer, with a local deterministic SSE server.
// There is no external model request, and no conversation/source text is saved.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ClineCore} from '../../../packages/agent-runtime/node_modules/@cline/sdk/dist/index.js';
import {lightSemanticHarnessTools} from '../../../packages/agent-runtime/dist/harness/light-tools.js';
import {createContextProjectionExtension} from '../../../packages/agent-runtime/dist/context-projection.js';
import {createProviderCompatibleFetch} from '../../../packages/agent-runtime/dist/provider-schema-compatibility.js';
import {appendProductionConfig} from '../../../packages/agent-runtime/dist/production.js';
import {toolPolicies} from '../../../packages/agent-runtime/dist/cline-runtime-configuration.js';
import {feedbackEnvelope} from '../../../packages/agent-runtime/dist/tool-result-envelope.js';
import {feedbackReceipts} from './receipt-metadata.mjs';
import {scopeMetadata} from '../feedback-ablation-study/scope-observations.mjs';
const report=[];
for(const projection of [false,true])for(const largeOutput of [false,true]){
 const root=await mkdtemp(join(tmpdir(),'blame-f65-sdk-')),sessionId='f65-'+randomUUID(),requests=[],offers=[];
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'node --test'}}));
 await writeFile(join(root,'suite.test.cjs'),"require('node:test').test('control',()=>{});\n");
 await writeFile(join(root,'changed.test.ts'),'export const marker=1;\n');
 const tools=lightSemanticHarnessTools(root,{taskContract:{session_id:sessionId}}).filter(t=>t.name==='run_task');
 const execute=tools[0].execute;tools[0]={...tools[0],execute:async(...args)=>{
  const result=await execute(...args);assert.equal(result.status,'ok');assert.ok(result.data.testValidationScope);
  if(largeOutput)result.data.output='bounded diagnostic line\n'.repeat(1600);
  offers.push(feedbackReceipts({input:[{type:'function_call',call_id:'check',name:'run_task'},{type:'function_call_output',call_id:'check',output:JSON.stringify(result)}]})[0]);if(process.env.BLAME_STUDY_MULTIPART==='true'){const {output,...data}=result.data;return [{type:'text',text:JSON.stringify({...result,data})},{type:'text',text:output}];}return process.env.BLAME_STUDY_ENVELOPE==='true'?feedbackEnvelope(result):result;
 }};
 const server=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;requests.push(JSON.parse(raw));
  const delta=requests.length===1?{role:'assistant',tool_calls:[{index:0,id:'check',type:'function',function:{name:'run_task',arguments:JSON.stringify({kind:'project',task:'test',args:['--test-name-pattern=control','suite.test.cjs']})}}]}:{role:'assistant',content:'Control completed.'};
  const chunks=[{id:sessionId,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]},{id:sessionId,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:requests.length===1?'tool_calls':'stop'}]}];
  res.writeHead(200,{'content-type':'text/event-stream'});for(const c of chunks)res.write('data: '+JSON.stringify(c)+'\n\n');res.end('data: [DONE]\n\n');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const core=await ClineCore.create({backendMode:'local',clientName:'blame-feedback-controls',fetch:createProviderCompatibleFetch(globalThis.fetch),toolPolicies:toolPolicies(true)});
 try{
  const result=await core.start({prompt:'Run the requested check, then report.',interactive:false,source:'f65-local-control',config:appendProductionConfig({
   sessionId,providerId:'openai-compatible',modelId:'offline-control',apiKey:'local-control',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,cwd:root,workspaceRoot:root,
   checkpoint:{enabled:false},enableAgentTeams:false,enableSpawnAgent:false,enableTools:true,extraTools:tools,maxIterations:3,mode:'act',systemPrompt:'Execute the supplied tool request.',
   ...(projection?{extensions:[createContextProjectionExtension({emit:()=>{},systemPrompt:'Execute the supplied tool request.',tools})]}:{}),
  })});assert.equal(result.result?.text,'Control completed.');assert.equal(requests.length,2);if(!offers.length)console.error('CONTROL_TOOL_ERRORS',JSON.stringify(requests[1].messages?.filter(m=>m.role==='tool')).slice(0,1000));assert.equal(offers.length,1);
  const recognized=feedbackReceipts(requests[1]),old=scopeMetadata(requests[1]);
  report.push({projection,largeOutput,localHttpRequests:requests.length,offers:offers.length,recognized:recognized.length,oldObserver:old.length,
   exactReceiptPreserved:recognized.some(r=>r.scopeSha256===offers[0].scopeSha256&&r.invocationSourceRevisionId===offers[0].invocationSourceRevisionId),
   toolChars:JSON.stringify(requests[1].messages?.filter(m=>m.role==='tool')).length});
 }finally{await core.delete(sessionId).catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{force:true,recursive:true});}
}
const output=process.env.BLAME_STUDY_CONTROL_OUTPUT;
if(output){await mkdir(join(output,'..'),{recursive:true});await writeFile(output,JSON.stringify({externalModelRequests:0,sdkVersion:'0.2.0',report},null,2)+'\n');}
console.log(JSON.stringify(report,null,2));
