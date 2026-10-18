import {createHash} from 'node:crypto';
import {provenanceWireObservation} from './provenance-observations.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
export function scopeMetadata(body){
 const receipts=[];
 function consume(v,id,depth=0){
  if(depth>10)return;if(typeof v==='string'){try{consume(JSON.parse(v),id,depth+1);}catch{}return;}
  if(Array.isArray(v)){for(const x of v)consume(x,id,depth+1);return;}if(!v||typeof v!=='object')return;
  const scope=v.data?.testValidationScope;
  if(scope?.kind==='runtime_test_scope'&&scope.testCompilation==='not_established')receipts.push({callIdSha256:typeof id==='string'?sha(id):null,contextSha256:sha(JSON.stringify(scope)),contextJsonBytes:Buffer.byteLength(JSON.stringify(scope)),changedTestCount:scope.changedTestCount,forwardedArgumentCount:scope.forwardedArgs?.length??null});
  if(v.type==='text'||v.type==='input_text')consume(v.text,id,depth+1);if(v.type==='tool_result')consume(v.content,id,depth+1);
  if(v.result!==undefined)consume(v.result,id,depth+1);if(v.output!==undefined)consume(v.output,id,depth+1);
 }
 for(const item of [...(Array.isArray(body.input)?body.input:[]),...(Array.isArray(body.messages)?body.messages:[])]){
  if(item.type==='function_call_output'||item.type==='custom_tool_call_output')consume(item.output,item.call_id);
  else if(item.role==='tool')consume(item.content,item.tool_call_id);
  else if(Array.isArray(item.content))for(const part of item.content)if(part.type==='tool_result')consume(part.content,part.tool_use_id);
 }
 return receipts;
}
export function scopeWireObservation(metadata,wire){return provenanceWireObservation(metadata.map(m=>({...m,validationStates:m.testScopes})),wire);}
export function scopeObservations(tools){return tools.flatMap((t,index)=>{
 const data=t.output?.data?.completed?.data??t.output?.data,scope=data?.testValidationScope;if(!scope)return [];
 const selections=scope.nextTypecheckSelections??[];
 return [{index,scope,followingLiteralSelectionIndices:tools.flatMap((n,j)=>j>index&&n.tool==='run_task'&&selections.some(s=>n.input?.kind==='project'&&n.input.task===s.input.task&&JSON.stringify(n.input.args??[])===JSON.stringify(s.input.args??[]))?[j]:[])}];
});}
export function handoffText(instruction){const marker='Controlled handoff (recorded before this session; no previous result is admitted here):\n';const i=instruction.indexOf(marker);return i<0?undefined:instruction.slice(i+marker.length).trim();}
export function handoffMetadata(body,expected){
 if(!expected)return null;const texts=[];
 const consume=v=>{if(typeof v==='string')texts.push(v);else if(Array.isArray(v))v.forEach(consume);else if(v&&['input_text','text'].includes(v.type)&&typeof v.text==='string')texts.push(v.text);};
 for(const i of [...(Array.isArray(body.input)?body.input:[]),...(Array.isArray(body.messages)?body.messages:[])])if(i.role==='user')consume(i.content);
 return {sha256:sha(expected),utf8Bytes:Buffer.byteLength(expected),userContextContainsExactHandoff:texts.some(t=>t.includes(expected))};
}
