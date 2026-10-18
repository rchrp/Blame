// Deterministic exposure/chronology counts, not inferred model reasoning.
export function feedbackObservations(tools){
 const repairs=[],headers=[];let bodyEdits=0;
 for(const [index,t]of tools.entries()){
  bodyEdits+=(t.input?.operations??[]).filter(o=>o.kind==='symbol'&&o.action==='replace_body').length;
  const r=t.output?.data?.validationRepair;
  if(r?.repairFirst?.length){
   const next=tools.findIndex((n,j)=>j>index&&n.observedIteration>t.observedIteration&&n.tool==='run_task');
   const exact=next<0?null:r.repairFirst.find(f=>{const a=f.input,b=tools[next].input;return b?.kind==='project'&&b.task===a.task&&JSON.stringify(b.args??[])===JSON.stringify(a.args??[])||b?.kind==='command'&&!a.args?.length&&b.command==='npm run '+a.task;});
   repairs.push({index,observedIteration:t.observedIteration,repairFirst:r.repairFirst,bytes:Buffer.byteLength(JSON.stringify(r)),nextRunTaskIndex:next<0?null:next,exactNextSelection:!!exact});
  }
  const h=t.output?.data?.bodyEditContext??t.output?.bodyEditContext;
  if(h)headers.push({index,observedIteration:t.observedIteration,context:h,bytes:Buffer.byteLength(JSON.stringify(h)),status:t.output.status});
 }
 const bindingErrors=tools.flatMap((t,index)=>/TS(?:2300|2304|2451|2552)\b|Cannot find name|Duplicate identifier|Cannot redeclare block-scoped/.test(JSON.stringify(t.output??{}))?[{index,tool:t.tool,input:t.input}]:[]);
 return {bodyEdits,repairs,headers,bindingErrors};
}
export function mechanismGate(rows,protocol){
 const candidate=rows.filter(r=>r.arm==='candidate');
 if(protocol.mechanismKind==='repair')return candidate.some(r=>r.feedback.repairs.some(x=>x.exactNextSelection));
 if(protocol.mechanismKind==='body')return candidate.some(r=>r.feedback.headers.length>0);
 return candidate.some(r=>r.navigationOffers.some(o=>o.followedIndices.length>0)||r.feedback.headers.length>0||r.feedback.repairs.some(x=>x.exactNextSelection));
}
