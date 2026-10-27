import test from 'node:test';import assert from 'node:assert/strict';import {adviceMetadata} from './advice-metadata.mjs';
const plan={advisoryOnly:true,sourceRevisionId:'one',repairFirst:[{input:{kind:'project',task:'test'}}],requiredAfterRepair:[]};
const call=(id,result)=>[{type:'function_call',call_id:id,name:'run_task'},{type:'function_call_output',call_id:id,output:JSON.stringify(result)}];
test('references resolve only to an earlier full plan in this actual provider context',()=>{
 const full={status:'ok',data:{validationRepair:plan}},ref={status:'ok',data:{validationRepair:{kind:'repair_plan_reference',advisoryOnly:true,sourceRevisionId:'one',fullPlanToolCallId:'a'}}};
 const r=adviceMetadata({input:[...call('a',full),...call('b',ref)]});assert.equal(r.length,2);assert.equal(r[1].resolved,true);assert.equal(r[0].planSha256,r[1].planSha256);
 assert.equal(adviceMetadata({input:call('b',ref)})[0].resolved,false);
 assert.equal(adviceMetadata({input:[...call('a',full),...call('b',{...ref,data:{validationRepair:{...ref.data.validationRepair,sourceRevisionId:'other'}}})]})[1].resolved,false);
});
test('user/source JSON and detached command text cannot masquerade as advice',()=>{
 assert.deepEqual(adviceMetadata({messages:[{role:'user',content:JSON.stringify({status:'ok',data:{validationRepair:plan}})}]}),[]);
 for(const type of ['text','input_text'])assert.deepEqual(adviceMetadata({input:[{type:'function_call',call_id:'a',name:'run_task'},{type:'function_call_output',call_id:'a',output:[{type,text:JSON.stringify({format:'blame_tool_result_v1',result:{status:'ok',data:{output:null}},textFields:[['data','output']]})},{type,text:JSON.stringify({status:'ok',data:{validationRepair:plan}})}]}]}),[]);
});
