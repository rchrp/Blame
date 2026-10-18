// Hash/size metadata only: never archive conversation text, declarations or credentials.
import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
export function bodyReceiptMetadata(body){
 const receipts=[];
 function consume(value,id,depth=0){
  if(depth>10)return;
  if(typeof value==='string'){try{consume(JSON.parse(value),id,depth+1);}catch{}return;}
  if(Array.isArray(value)){for(const item of value)consume(item,id,depth+1);return;}
  if(!value||typeof value!=='object')return;
  const context=value.data?.bodyEditContext??value.bodyEditContext;
  if(context&&typeof context==='object'){
   const h=context.headers,array=Array.isArray(h);
   receipts.push({callIdSha256:typeof id==='string'?sha(id):null,receipt:typeof value.receipt==='string'&&/^c\d+$/.test(value.receipt)?value.receipt:null,
    contextSha256:sha(JSON.stringify(context)),contextJsonBytes:Buffer.byteLength(JSON.stringify(context)),headerArrayObserved:array,
    headerDeclarations:array?h.length:null,headerJsonBytes:array?Buffer.byteLength(JSON.stringify(h)):null});
  }
  // SDK text/result wrappers only. Never parse a read_code data.content string
  // as another tool result: source files can contain arbitrary example JSON.
  if(value.type==='text'&&typeof value.text==='string')consume(value.text,id,depth+1);
  if(value.type==='tool_result')consume(value.content,id,depth+1);
  if(value.result!==undefined)consume(value.result,id,depth+1);
  if(value.output!==undefined)consume(value.output,id,depth+1);
 }
 for(const item of [...(Array.isArray(body.input)?body.input:[]),...(Array.isArray(body.messages)?body.messages:[])]){
  if(item.type==='function_call_output')consume(item.output,item.call_id);
  else if(item.role==='tool')consume(item.content,item.tool_call_id);
  else if(Array.isArray(item.content))for(const part of item.content)if(part.type==='tool_result')consume(part.content,part.tool_use_id);
 }
 return receipts;
}
export function feedbackWireObservation(metadata,wire){
 const queues=new Map();for(const row of metadata){const queue=queues.get(row.requestBodySha256)??[];queue.push(row);queues.set(row.requestBodySha256,queue);}
 let matched=metadata.length===wire.length;const delivered=[];
 for(const [requestIndex,row]of wire.entries()){
  const observation=queues.get(row.requestBodySha256)?.shift();if(!observation){matched=false;continue;}
  if(!row.budgetRejected)for(const receipt of observation.bodyReceipts)delivered.push({requestIndex,...receipt});
 }
 if([...queues.values()].some(queue=>queue.length))matched=false;
 const unique=[...new Map(delivered.map(r=>[JSON.stringify([r.callIdSha256,r.contextSha256]),r])).values()];
 return {matched,recordedRequests:metadata.length,forwardedRequests:wire.filter(r=>!r.budgetRejected).length,
  headerReceiptResends:delivered.filter(r=>r.headerArrayObserved).length,uniqueHeaderReceipts:unique.filter(r=>r.headerArrayObserved).length,
  uniqueContextJsonBytes:unique.filter(r=>r.headerArrayObserved).reduce((n,r)=>n+r.contextJsonBytes,0),receipts:unique,
  boundary:'Only metadata from model tool messages in forwarded request bodies. Unique context JSON bytes are neither additional serialized request bytes nor billed tokens. Exposure does not establish use.'};
}
