// A new observer. Historical F63/F64 metadata and scores are never rewritten.
import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
function envelope(text){
 try{return JSON.parse(text);}catch{}
 // Blame's presenter keeps metadata on the first line, then labelled fenced
 // source/output sections. Never scan those sections or arbitrary source JSON.
 const newline=text.indexOf('\n');if(newline<0)return;
 try{const value=JSON.parse(text.slice(0,newline));return record(value)&&['ok','blocked'].includes(value.status)&&/^\n\n[\w.[\]]+:\n`{3,}/u.test(text.slice(newline))?value:undefined;}catch{}
}
export function feedbackReceipts(body){
 const entries=[...(Array.isArray(body.input)?body.input:[]),...(Array.isArray(body.messages)?body.messages:[])],names=new Map(),receipts=[];
 for(const item of entries){
  if(item.type==='function_call'||item.type==='custom_tool_call')names.set(item.call_id,item.name);
  if(item.role==='assistant')for(const call of item.tool_calls??[])names.set(call.id,call.function?.name);
  if(Array.isArray(item.content))for(const part of item.content)if(part.type==='tool_use')names.set(part.id,part.name);
 }
 function consume(value,id,name,depth=0){
  if(depth>10||name!=='run_task')return;
  if(typeof value==='string'){const parsed=envelope(value);if(parsed!==undefined)consume(parsed,id,name,depth+1);return;}
  if(Array.isArray(value)){
   const first=value[0];
   if(first?.type==='text'&&typeof first.text==='string'){
    let header;try{header=JSON.parse(first.text);}catch{}
    if(header?.format==='blame_tool_result_v1'&&Array.isArray(header.textFields)){
     consume(header.result,id,name,depth+1);return; // Detached command/source text is never evidence.
    }
   }
   for(const item of value)consume(item,id,name,depth+1);return;
  }
  if(!record(value))return;
  const data=value.status==='ok'&&record(value.data)?value.data:undefined,scope=data?.testValidationScope;
  if(scope?.kind==='runtime_test_scope'&&scope.testCompilation==='not_established')receipts.push({
   callIdSha256:sha(id??''),scopeSha256:sha(JSON.stringify(scope)),scopeBytes:Buffer.byteLength(JSON.stringify(scope)),
   invocationSourceRevisionId:data.reporting?.invocationSourceRevisionId??null,
   completedSourceRevisionId:data.reporting?.completedSourceRevisionId??null,
  });
  // Only transport and the documented running-command envelope are traversed.
  if(data?.completed)consume(data.completed,id,name,depth+1);
  if(['text','input_text'].includes(value.type)&&typeof value.text==='string')consume(value.text,id,name,depth+1);
  if(value.type==='tool_result')consume(value.content,id,name,depth+1);
  if(value.result!==undefined)consume(value.result,id,name,depth+1);
  if(value.output!==undefined)consume(value.output,id,name,depth+1);
 }
 for(const item of entries){
  if(['function_call_output','custom_tool_call_output'].includes(item.type))consume(item.output,item.call_id,names.get(item.call_id));
  else if(item.role==='tool')consume(item.content,item.tool_call_id,names.get(item.tool_call_id));
  else if(Array.isArray(item.content))for(const part of item.content)if(part.type==='tool_result')consume(part.content,part.tool_use_id,names.get(part.tool_use_id));
 }
 return receipts;
}
