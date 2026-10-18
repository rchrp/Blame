import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';import {join} from 'node:path';
import {lightSemanticHarnessTools} from '../../../packages/agent-runtime/dist/harness/light-tools.js';
import {sanitizeValue} from '../../../packages/benchmark-runner/dist/event-recorder.js';
import {bodyReceiptMetadata,feedbackWireObservation} from './feedback-wire-metadata.mjs';
import {work,study,save,sha} from './setup.mjs';
import {panel} from './panels.mjs';
import {provenanceMetadata,provenanceWireObservation} from './provenance-observations.mjs';
import {scopeMetadata,scopeWireObservation,handoffMetadata} from './scope-observations.mjs';
const root=await mkdtemp(join(work,'header-boundary-'));
try{
 await writeFile(join(root,'value.ts'),'export function clamp(value:number,{min,max}:{min:number;max:number}):number{return value;}\n');
 const tools=lightSemanticHarnessTools(root),read=tools.find(t=>t.name==='read_code'),edit=tools.find(t=>t.name==='edit_code');
 assert.equal((await read.execute({target:'value.ts#clamp'},{})).status,'ok');
 const result=await edit.execute({operations:[{kind:'symbol',target:'value.ts#clamp',action:'replace_body',content:'return Math.min(max,Math.max(min,value));'}]},{});
 assert.equal(result.status,'ok');assert.ok(Array.isArray(result.data.bodyEditContext.headers));assert.match(result.data.bodyEditContext.headers[0].header,/value:number/);
 const recorded=sanitizeValue(result);assert.equal(recorded.data.bodyEditContext.headers,'[REDACTED]');
 const responses={model:'control',input:[{type:'function_call_output',call_id:'control',output:JSON.stringify(result)}]},chat={messages:[{role:'tool',tool_call_id:'control',content:JSON.stringify(result)}]};
 let provenance=null;
 if(panel.id==='F62'||panel.date){
  await writeFile(join(root,'suite.test.cjs'),"require('node:test').test('case',()=>{});\n");await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'node --test suite.test.cjs'}}));
  const run=tools.find(t=>t.name==='run_task');assert.equal((await run.execute({kind:'project',task:'test'},{})).status,'ok');
  const changed=await edit.execute({operations:[{kind:'patch',path:'marker.ts',patch:'export const marker=1;\n'}]},{});
  assert.ok(changed.data.validationState?.invalidatedChecks.length);
  responses.input.push({type:'function_call_output',call_id:'provenance',output:JSON.stringify(changed)});
  provenance=provenanceMetadata(responses);assert.equal(provenance.length,1);
  assert.deepEqual(provenanceMetadata({messages:[{role:'user',content:JSON.stringify(changed)}]}),[]);
  assert.deepEqual(provenanceMetadata({input:[{type:'function_call_output',output:JSON.stringify({status:'ok',data:{content:JSON.stringify(changed)}})}]}),[]);
 }
 let scopes=null,controlled=null;
 if(panel.date){
  assert.equal((await edit.execute({operations:[{kind:'patch',path:'changed.test.ts',patch:'export const testValue=1;\n'}]},{})).status,'ok');
  const output=await tools.find(t=>t.name==='run_task').execute({kind:'project',task:'test',args:['types']},{});
  assert.equal(output.status,'ok');assert.equal(output.data.testValidationScope.testCompilation,'not_established');
  responses.input.push({type:'function_call_output',call_id:'scope',output:JSON.stringify(output)});
  scopes=scopeMetadata(responses);assert.equal(scopes.length,1);
  assert.deepEqual(scopeMetadata({messages:[{role:'user',content:JSON.stringify(output)}]}),[]);
  assert.deepEqual(scopeMetadata({input:[{type:'function_call_output',output:JSON.stringify({status:'ok',data:{content:JSON.stringify(output)}})}]}),[]);
  controlled=JSON.stringify({context:'known control handoff'});
  responses.input.push({role:'user',content:[{type:'input_text',text:'prefix\n'+controlled}]});
  assert.equal(handoffMetadata(responses,controlled).userContextContainsExactHandoff,true);
  assert.equal(handoffMetadata({input:[{type:'function_call_output',output:controlled}]},controlled).userContextContainsExactHandoff,false);
  const instruction=join(root,'instruction.txt');await writeFile(instruction,'Controlled handoff (recorded before this session; no previous result is admitted here):\n'+controlled+'\n');
  process.env.BLAME_STUDY_HANDOFF_INSTRUCTION=instruction;process.env.BLAME_STUDY_SCOPE_AUDIT='true';
 }
 const metadata=bodyReceiptMetadata(responses);assert.equal(metadata.length,1);assert.equal(metadata[0].headerArrayObserved,true);assert.equal(metadata[0].headerDeclarations,1);assert.ok(metadata[0].contextJsonBytes>Buffer.byteLength(JSON.stringify(recorded.data.bodyEditContext)));assert.deepEqual(bodyReceiptMetadata(chat),metadata);
 const hash='a'.repeat(64),record={requestBodySha256:hash,bodyReceipts:metadata},forwarded=[{requestBodySha256:hash,budgetRejected:false}];
 const observed=feedbackWireObservation([record],forwarded);assert.equal(observed.matched,true);assert.equal(observed.uniqueHeaderReceipts,1);assert.equal(observed.headerReceiptResends,1);
 const twice=feedbackWireObservation([record,record],[...forwarded,...forwarded]);assert.equal(twice.uniqueHeaderReceipts,1);assert.equal(twice.headerReceiptResends,2);
 assert.equal(feedbackWireObservation([],forwarded).matched,false);assert.equal(feedbackWireObservation([record],[]).matched,false);
 assert.equal(feedbackWireObservation([record],[{requestBodySha256:hash,budgetRejected:true}]).uniqueHeaderReceipts,0);
 // Exercise both actual preloads against an in-process fake fetch; no network.
 const sent=[];globalThis.fetch=async(input,init)=>{sent.push({input,init});return new Response('{}',{status:200});};
 process.env.BLAME_STUDY_WIRE_AUDIT=join(root,'contracts.jsonl');process.env.BLAME_STUDY_FEEDBACK_WIRE_AUDIT=join(root,'feedback.jsonl');
 await import('../navigation-evidence/wire-audit.mjs?feedback-control');
 if(panel.id==='F62'||panel.date){process.env.BLAME_STUDY_PROVENANCE_AUDIT='true';process.env.BLAME_STUDY_TIMING_AUDIT=join(root,'timing.jsonl');await import('../request-timing-preload.mjs?feedback-control');}
 await import('./feedback-wire-audit.mjs?feedback-control');
 const serialized=JSON.stringify(responses);await(await fetch('https://control.invalid/responses',{method:'POST',body:serialized,headers:{authorization:'control-only'}})).text();
 assert.equal(sent.length,1);assert.equal(sent[0].init.body,serialized);
 const contract=JSON.parse((await readFile(join(root,'contracts.jsonl'),'utf8')).trim()),proof=JSON.parse((await readFile(join(root,'feedback.jsonl'),'utf8')).trim());
 assert.equal(contract.requestBodySha256,proof.requestBodySha256);assert.deepEqual(proof.bodyReceipts,metadata);assert.equal(proof.bodyReceipts[0].headerArrayObserved,true);
 if(panel.id==='F62'||panel.date){
  const timing=(await readFile(join(root,'timing.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(timing[0].requestBodySha256,contract.requestBodySha256);assert.equal(timing.at(-1).event,'body_end');
  assert.deepEqual(proof.validationStates,provenance);assert.equal(provenanceWireObservation([proof],[contract]).uniqueReceipts,1);
  assert.equal(provenanceWireObservation([{...proof,validationStates:undefined}],[contract]).matched,false);
  assert.equal(provenanceWireObservation([proof],[{...contract,budgetRejected:true}]).uniqueReceipts,0);
 }
 if(panel.date){assert.deepEqual(proof.testScopes,scopes);assert.equal(scopeWireObservation([proof],[contract]).uniqueReceipts,1);assert.equal(scopeWireObservation([proof],[{...contract,budgetRejected:true}]).uniqueReceipts,0);assert.equal(scopeWireObservation([{...proof,testScopes:undefined}],[contract]).matched,false);assert.equal(proof.controlledHandoff.userContextContainsExactHandoff,true);}
 assert.ok(!(await readFile(join(root,'feedback.jsonl'),'utf8')).includes('function clamp'));assert.ok(!(await readFile(join(root,'feedback.jsonl'),'utf8')).includes('control-only'));
 const text={input:[{type:'function_call_output',call_id:'control',output:JSON.stringify([{type:'text',text:JSON.stringify(result)}])}]};assert.deepEqual(bodyReceiptMetadata(text),metadata);
 assert.equal(bodyReceiptMetadata({input:[{type:'function_call_output',output:JSON.stringify(recorded)}]})[0].headerArrayObserved,false);
 assert.deepEqual(bodyReceiptMetadata({messages:[{role:'user',content:JSON.stringify(result)}]}),[]);
 assert.deepEqual(bodyReceiptMetadata({input:[{type:'function_call_output',output:JSON.stringify({status:'ok',data:{content:JSON.stringify(result)}})}]}),[]);
 assert.deepEqual(bodyReceiptMetadata({headers:{authorization:'control'},messages:[{role:'tool',content:'not JSON'}]}),[]);
 assert.equal(sanitizeValue({headers:{authorization:'control'},token:'control'}).headers,'[REDACTED]');
 await save(join(study,'feedback-boundary-controls.json'),{modelRequests:0,complete:true,actualModelToolHeaderArrayRetained:true,benchmarkRecorderArrayMasked:true,modelContextMetadata:metadata[0],...(provenance?{actualProvenanceReceiptMetadata:provenance[0],timingPreloadPreservesRequest:true}:{}),...(scopes?{actualScopeMetadata:scopes[0],explicitUserHandoffDistinctFromToolReceipt:true}:{}),knownRepresentations:['Responses function_call_output','chat tool','SDK text wrapper'],ignored:['user JSON','source file JSON in data.content','transport headers','malformed tool text'],credentialFieldMaskingPreserved:true,actualPreloadsPreserveRequestAndJoinHashes:true,sourceHashes:Object.fromEntries(await Promise.all(['feedback-wire-audit','feedback-wire-metadata','feedback-boundary-controls',...((panel.id==='F62'||panel.date)?['provenance-observations']:[]),...(panel.date?['scope-observations']:[])].map(async n=>[n+'.mjs',sha(await readFile(join(import.meta.dirname,n+'.mjs')))]))),boundary:'Actual Light SDK tool execute() response retains declarations. Typed scope metadata ignores user/source JSON; explicit handoff presence is separately measured. Exposure is not comprehension/use. Context JSON bytes are not extra billed tokens.'});
 console.log('Actual SDK Light tool headers retained; recorder masking and metadata-only representations verified; zero model calls.');
}finally{await rm(root,{recursive:true});}
