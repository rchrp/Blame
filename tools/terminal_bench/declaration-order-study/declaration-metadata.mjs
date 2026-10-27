import {digest} from '../durable-campaign.mjs';
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
function parsed(s){try{return JSON.parse(s);}catch{}try{const i=s.indexOf('\n');if(i>0&&/^\n\n[\w.[\]]+:\n`{3,}/u.test(s.slice(i)))return JSON.parse(s.slice(0,i));}catch{}return;}
export function declarationMetadata(body){
 const items=[...(body.input??[]),...(body.messages??[])],names=new Map(),receipts=[];
 for(const i of items){if(['function_call','custom_tool_call'].includes(i.type))names.set(i.call_id,i.name);if(i.role==='assistant')for(const c of i.tool_calls??[])names.set(c.id,c.function?.name);if(i.role==='assistant'&&Array.isArray(i.content))for(const c of i.content)if(c.type==='tool_use')names.set(c.id,c.name);}
 function consume(v,id,depth=0){
  if(depth>12||names.get(id)!=='search_code')return;
  if(typeof v==='string'){const p=parsed(v);if(p!==undefined)consume(p,id,depth+1);return;}
  if(Array.isArray(v)){
   const first=v[0];if(['text','input_text'].includes(first?.type))try{const h=JSON.parse(first.text);if(h.format==='blame_tool_result_v1'&&Array.isArray(h.textFields)){consume(h.result,id,depth+1);return;}}catch{}
   for(const p of v)consume(p,id,depth+1);return;
  }
  if(!object(v))return;const d=v.status==='ok'?v.data:undefined,discovery=d?.declarationDiscovery;
  if(discovery?.engine==='syntax'&&Array.isArray(d.declarationCandidates))receipts.push({callIdSha256:digest(id),status:discovery.status,sourceRevision:discovery.sourceRevision??null,navigationOnly:discovery.navigationOnly===true,limited:discovery.limited,visitedFiles:discovery.visitedFiles,readBytes:discovery.readBytes,limits:discovery.limits,candidates:d.declarationCandidates.map(c=>({path:c.path,qualifiedName:c.qualifiedName,kind:c.kind,targetSha256:typeof c.target==='string'?digest(c.target):null}))});
  if(['text','input_text'].includes(v.type))consume(v.text,id,depth+1);if(v.type==='tool_result')consume(v.content,id,depth+1);if(v.result!==undefined)consume(v.result,id,depth+1);if(v.output!==undefined)consume(v.output,id,depth+1);
 }
 for(const i of items){if(['function_call_output','custom_tool_call_output'].includes(i.type))consume(i.output,i.call_id);else if(i.role==='tool')consume(i.content,i.tool_call_id);else if(Array.isArray(i.content))for(const p of i.content)if(p.type==='tool_result')consume(p.content,p.tool_use_id);}
 return receipts;
}
