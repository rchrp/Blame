import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
// Only typed tool-result wrappers, never user/source data.content text.
export function provenanceMetadata(body){
 const receipts=[];
 function consume(value,id,depth=0){
  if(depth>10)return;
  if(typeof value==='string'){try{consume(JSON.parse(value),id,depth+1);}catch{}return;}
  if(Array.isArray(value)){for(const item of value)consume(item,id,depth+1);return;}
  if(!value||typeof value!=='object')return;
  const c=value.data?.validationState;
  if(c&&typeof c.sourceRevisionId==='string'&&Array.isArray(c.invalidatedChecks)&&c.invalidatedChecks.every(x=>x.eligibleForCurrentSource===false))
   receipts.push({callIdSha256:typeof id==='string'?sha(id):null,contextSha256:sha(JSON.stringify(c)),contextJsonBytes:Buffer.byteLength(JSON.stringify(c)),invalidatedChecks:c.invalidatedChecks.length,omitted:c.omitted??null});
  if(value.type==='text'||value.type==='input_text')consume(value.text,id,depth+1);
  if(value.type==='tool_result')consume(value.content,id,depth+1);
  if(value.result!==undefined)consume(value.result,id,depth+1);
  if(value.output!==undefined)consume(value.output,id,depth+1);
 }
 for(const item of [...(Array.isArray(body.input)?body.input:[]),...(Array.isArray(body.messages)?body.messages:[])]){
  if(item.type==='function_call_output'||item.type==='custom_tool_call_output')consume(item.output,item.call_id);
  else if(item.role==='tool')consume(item.content,item.tool_call_id);
  else if(Array.isArray(item.content))for(const part of item.content)if(part.type==='tool_result')consume(part.content,part.tool_use_id);
 }
 return receipts;
}
export function provenanceWireObservation(metadata,wire){
 const queues=new Map();for(const m of metadata){const q=queues.get(m.requestBodySha256)??[];q.push(m);queues.set(m.requestBodySha256,q);}
 let matched=metadata.length===wire.length&&metadata.every(m=>Array.isArray(m.validationStates));const receipts=[];
 for(const [requestIndex,w]of wire.entries()){
  const m=queues.get(w.requestBodySha256)?.shift();if(!m){matched=false;continue;}
  if(!w.budgetRejected)for(const r of m.validationStates??[])receipts.push({requestIndex,...r});
 }
 if([...queues.values()].some(q=>q.length))matched=false;
 const unique=[...new Map(receipts.map(r=>[JSON.stringify([r.callIdSha256,r.contextSha256]),r])).values()];
 return {matched,uniqueReceipts:unique.length,resends:receipts.length,contextJsonBytes:unique.reduce((n,r)=>n+r.contextJsonBytes,0),receipts:unique,
  meaning:'Actual forwarded tool-message metadata. Exposure is not comprehension or causal mediation. Context bytes are not extra billed tokens.'};
}
export function provenanceObservations(tools){
 return tools.flatMap((t,index)=>{
  const c=t.output?.data?.validationState;if(!['edit_code','run_task'].includes(t.tool)||!c)return [];
  const reruns=tools.flatMap((next,j)=>{
   if(j<=index||next.tool!=='run_task'||next.input?.kind!=='project')return [];
   const d=next.output?.data??{},source=d.reporting?.invocationSourceRevisionId??d.validation?.sourceRevisionId;
   if(source!==c.sourceRevisionId)return [];
   return c.invalidatedChecks.some(v=>v.task===next.input.task&&JSON.stringify(v.args??[])===JSON.stringify(next.input.args??[])&&
    v.cwd===(d.reporting?.cwd??d.check?.evidence?.cwd??'.'))?[j]:[];
  });
  return [{index,sourceRevisionId:c.sourceRevisionId,invalidatedChecks:c.invalidatedChecks,omitted:c.omitted,
   bytes:Buffer.byteLength(JSON.stringify(c)),confirmedSameSourceRerunIndices:reruns}];
 });
}
