import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
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
import {declarationMetadata} from './declaration-metadata.mjs';
function parse(value){
 if(typeof value==='string'){try{return parse(JSON.parse(value));}catch{}try{return parse(JSON.parse(value.split('\n')[0]));}catch{return;}}
 if(Array.isArray(value))return unwrapFeedbackEnvelope(value.map(p=>p.type==='input_text'?{...p,type:'text'}:p));
 return value;
}
const reports=[],previous=process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER;
try{for(const enabled of [false,true]){
 process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER=String(enabled);
 const root=await mkdtemp(join(tmpdir(),'declaration-order-')),session='declaration-'+randomUUID(),requests=[];
 await mkdir(join(root,'src/__tests__'),{recursive:true});await writeFile(join(root,'package.json'),'{\"type\":\"module\"}');
 for(let i=0;i<70;i++)await writeFile(join(root,'src/__tests__/a'+i+'.test.ts'),'// MutateOptions\n');
 await writeFile(join(root,'src/types.ts'),'export interface MutateOptions { done?: () => void }\n');
 const tools=lightSemanticHarnessTools(root,{taskContract:{session_id:session}}).filter(t=>['search_code','read_code'].includes(t.name));
 const calls=[{id:'discovery',name:'search_code',input:{query:'interface MutateOptions',scope:'src'}},{id:'explicit-read',name:'read_code',input:{target:'src/types.ts#MutateOptions',view:'symbol'}}];
 const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push(JSON.parse(raw));const call=calls[requests.length-1];
 const delta=call?{role:'assistant',tool_calls:[{index:0,id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.input)}}]}:{role:'assistant',content:'Control completed.'};
 res.writeHead(200,{'content-type':'text/event-stream'});for(const chunk of [{id:session,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]},{id:session,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}]}])res.write('data: '+JSON.stringify(chunk)+'\n\n');res.end('data: [DONE]\n\n');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const core=await ClineCore.create({backendMode:'local',clientName:'declaration-order-control',fetch:createProviderCompatibleFetch(globalThis.fetch),toolPolicies:toolPolicies(true)});
 try{
  const result=await core.start({prompt:'Execute the supplied requests.',interactive:false,config:appendProductionConfig({sessionId:session,providerId:'openai-compatible',modelId:'offline',apiKey:'local-control',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,cwd:root,workspaceRoot:root,checkpoint:{enabled:false},enableTools:true,enableAgentTeams:false,enableSpawnAgent:false,extraTools:tools,maxIterations:5,systemPrompt:'Execute the supplied tools.',extensions:[createContextProjectionExtension({emit:()=>{},systemPrompt:'Execute the supplied tools.',tools})]})});
  assert.equal(result.result?.text,'Control completed.');assert.equal(requests.length,3);
  const outputs=requests[2].messages.filter(m=>m.role==='tool'),discovery=parse(outputs[0].content)?.data;
  assert.ok(discovery.declarationDiscovery.navigationOnly);assert.equal(discovery.declarationDiscovery.limited,true);
  assert.equal(discovery.declarationCandidates.length,enabled?1:0);if(enabled)assert.equal(discovery.declarationCandidates[0].path,'src/types.ts');
  assert.equal(parse(outputs[1].content)?.status,'ok');
  const first=requests.slice(1).map(r=>JSON.stringify(r.messages.find(m=>m.role==='tool').content));assert.ok(first.every(v=>v===first[0]),'Previously forwarded result changed');
  const received=declarationMetadata(requests[2]);assert.equal(received.length,1);assert.equal(received[0].candidates.length,enabled?1:0);
  reports.push({enabled,localHttpRequests:requests.length,externalModelRequests:0,discoveryIsNavigationOnly:true,explicitReadAvailable:true,unchangedForwardedPrefix:true,actualProviderReceipts:received,firstToolsSha256:createHash('sha256').update(JSON.stringify(requests[0].tools)).digest('hex'),firstSystemSha256:createHash('sha256').update(JSON.stringify(requests[0].messages.filter(m=>m.role==='system'))).digest('hex')});
 }finally{await core.delete(session).catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
}}
finally{if(previous===undefined)delete process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER;else process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER=previous;}
assert.equal(reports[0].firstToolsSha256,reports[1].firstToolsSha256);assert.equal(reports[0].firstSystemSha256,reports[1].firstSystemSha256);await atomicJson(join(work,'sdk-controls.json'),{externalModelRequests:0,reports});console.log(JSON.stringify(reports,null,2));
