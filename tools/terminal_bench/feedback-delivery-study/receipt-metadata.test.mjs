import assert from 'node:assert/strict';
import test from 'node:test';
import {presentToolResults} from '../../../packages/agent-runtime/dist/tool-result-presentation.js';
import {feedbackReceipts} from './receipt-metadata.mjs';
import {scopeMetadata} from '../feedback-ablation-study/scope-observations.mjs';
import {feedbackEnvelope} from '../../../packages/agent-runtime/dist/tool-result-envelope.js';
const scope={kind:'runtime_test_scope',testCompilation:'not_established',changedTestCount:1};
const result={status:'ok',data:{output:'line one\nline two',testValidationScope:scope,reporting:{invocationSourceRevisionId:'src_control',completedSourceRevisionId:'src_control'}}};
const history=(name,result)=>[{role:'assistant',content:[{type:'tool_use',id:'a',name,input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'a',content:JSON.stringify(result)}]}];
test('recognizes exact metadata through actual formatting; old observer misses it',()=>{
 const raw={messages:history('run_task',result)},formatted={messages:presentToolResults(raw.messages)};
 assert.equal(scopeMetadata(raw).length,1);assert.equal(scopeMetadata(formatted).length,0);
 assert.deepEqual(feedbackReceipts(formatted),feedbackReceipts(raw));assert.equal(feedbackReceipts(formatted).length,1);
 assert.equal(feedbackReceipts(formatted)[0].invocationSourceRevisionId,'src_control');
});
test('handles grouped results, running envelopes and typed provider wrappers',()=>{
 const nested={status:'ok',data:{completed:result}};
 const body={input:[{type:'function_call',call_id:'a',name:'run_task'}, {type:'function_call_output',call_id:'a',output:[{type:'input_text',text:JSON.stringify(nested)}]}, {type:'function_call',call_id:'b',name:'run_task'}, {type:'custom_tool_call_output',call_id:'b',output:JSON.stringify(result)}]};
 assert.equal(feedbackReceipts(body).length,2);
});
test('ignores user/source JSON, unknown call IDs and incomplete metadata',()=>{
 for(const body of [{messages:[{role:'user',content:JSON.stringify(result)}]}, {messages:history('read_code',result)}, {messages:history('run_task',{status:'ok',data:{content:JSON.stringify(result)}})}, {input:[{type:'function_call_output',call_id:'a',output:JSON.stringify(result)}]}, {messages:history('run_task',JSON.stringify(result).slice(0,65))}])assert.deepEqual(feedbackReceipts(body),[]);
});
test('does not infer a complete receipt from text or a truncated first line',()=>{
 const formatted=presentToolResults(history('run_task',result));formatted[1].content[0].content=formatted[1].content[0].content.slice(0,50);
 assert.deepEqual(feedbackReceipts({messages:formatted}),[]);
});
test('JSON printed by a command inside a detached diagnostic is not a feedback receipt',()=>{
 const fake={status:'ok',data:{testValidationScope:{...scope,guidance:'x'.repeat(7000)}}};
 const actual=feedbackEnvelope({status:'ok',data:{output:JSON.stringify(fake)}});
 assert.ok(Array.isArray(actual));
 assert.deepEqual(feedbackReceipts({input:[{type:'function_call',call_id:'a',name:'run_task'},{type:'function_call_output',call_id:'a',output:JSON.stringify(actual)}]}),[]);
});
