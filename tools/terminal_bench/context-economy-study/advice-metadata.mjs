import {digest} from '../durable-campaign.mjs';
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
function parsed(text){try{return JSON.parse(text);}catch{}try{const i=text.indexOf('\n');if(i>0&&/^\n\n[\w.[\]]+:\n`{3,}/u.test(text.slice(i)))return JSON.parse(text.slice(0,i));}catch{}return;}
export function adviceMetadata(body){
 const items=[...(body.input??[]),...(body.messages??[])],names=new Map(),visible=new Map(),receipts=[];
 for(const item of items){if(['function_call','custom_tool_call'].includes(item.type))names.set(item.call_id,item.name);if(item.role==='assistant')for(const c of item.tool_calls??[])names.set(c.id,c.function?.name);if(item.role==='assistant'&&Array.isArray(item.content))for(const p of item.content)if(p.type==='tool_use')names.set(p.id,p.name);}
 function consume(value,id,depth=0){
  if(depth>12||!['run_task','read_code','edit_code'].includes(names.get(id)))return;
  if(typeof value==='string'){const p=parsed(value);if(p!==undefined)consume(p,id,depth+1);return;}
  if(Array.isArray(value)){
   const first=value[0];if(['text','input_text'].includes(first?.type)&&typeof first.text==='string'){
    let h;try{h=JSON.parse(first.text);}catch{}if(h?.format==='blame_tool_result_v1'&&Array.isArray(h.textFields)){consume(h.result,id,depth+1);return;}
   }for(const v of value)consume(v,id,depth+1);return;
  }
  if(!object(value))return;
  let plan=value.status==='ok'?value.data?.validationRepair:undefined;
  if(value.status==='blocked'&&typeof value.recovery==='string')try{plan=JSON.parse(value.recovery.split('\n').at(-1)).validationRepair;}catch{}
  if(plan?.advisoryOnly===true&&typeof plan.sourceRevisionId==='string'){
   const full=Array.isArray(plan.repairFirst)&&plan.repairFirst.length>0&&Array.isArray(plan.requiredAfterRepair);
   const prior=plan.kind==='repair_plan_reference'?visible.get(plan.fullPlanToolCallId):undefined;
   const hash=full?digest(JSON.stringify(plan)):prior?.source===plan.sourceRevisionId?prior.hash:null;
   if(full)visible.set(id,{hash,source:plan.sourceRevisionId});
   if(full||plan.kind==='repair_plan_reference')receipts.push({kind:full?'full':'reference',callIdSha256:digest(id),planSha256:hash,source:plan.sourceRevisionId,bytes:Buffer.byteLength(JSON.stringify(plan)),resolved:full||hash!==null,referencedCallIdSha256:typeof plan.fullPlanToolCallId==='string'?digest(plan.fullPlanToolCallId):null});
  }
  if(value.status==='ok'&&value.data?.completed)consume(value.data.completed,id,depth+1);
  if(['text','input_text'].includes(value.type))consume(value.text,id,depth+1);
  if(value.type==='tool_result')consume(value.content,id,depth+1);
  if(value.result!==undefined)consume(value.result,id,depth+1);
  if(value.output!==undefined)consume(value.output,id,depth+1);
 }
 for(const item of items){if(['function_call_output','custom_tool_call_output'].includes(item.type))consume(item.output,item.call_id);else if(item.role==='tool')consume(item.content,item.tool_call_id);else if(Array.isArray(item.content))for(const p of item.content)if(p.type==='tool_result')consume(p.content,p.tool_use_id);}
 return receipts;
}
