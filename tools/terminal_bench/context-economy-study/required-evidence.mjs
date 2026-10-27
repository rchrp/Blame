// Same conservative invocation/source rules for Light and native Cline.
import {unwrapFeedbackEnvelope} from '../../../packages/agent-runtime/dist/tool-result-envelope.js';
function record(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:undefined;}
export function decode(v){if(typeof v==='string')try{v=JSON.parse(v);}catch{}return unwrapFeedbackEnvelope(v);}
function commands(text,root){
 if(typeof text!=='string')return [];
 const parts=text.trim().split(/\s*&&\s*/u),out=[];
 for(let i=0;i<parts.length;i++){
  const p=parts[i].trim();
  if(i===0&&["cd "+root,"cd '"+root+"'",'cd "'+root+'"'].includes(p))continue;
  const m=/^npm\s+run\s+(['"]?)([A-Za-z0-9:_-]+)\1$/u.exec(p);if(!m)return [];out.push('npm run '+m[2]);
 }return out;
}
export function requiredEvidence(tools,epochs,finalSource,checks,root){
 const starts=new Map(),ends=new Map(),handles=new Map(),proved=new Map();
 for(const e of epochs)(e.phase==='started'?starts:ends).set(e.callId,e);
 const fresh=id=>starts.get(id)?.epoch?.sha256===finalSource&&ends.get(id)?.epoch?.sha256===finalSource&&!starts.get(id).error&&!ends.get(id).error;
 for(const t of tools){
  const id=t.toolCallId??t.toolCall?.id,input=t.input??t.toolCall?.input,output=decode(t.output);
  if(t.tool==='run_task'){
   const data=record(output)?.status==='ok'?record(output.data):undefined;if(!data)continue;
   if(typeof data.run==='string'&&input?.kind!=='inspect')handles.set(data.run,id);
   let completed=record(data.completed),result=completed?.status==='ok'?record(completed.data):data;
   if(!result||result.exitCode!==0||record(result.validation)?.status==='stale')continue;
   const initial=input?.kind==='inspect'?handles.get(input.run):id;
   if(!initial||!fresh(initial)||!fresh(id))continue;
   for(const command of commands(result.command,root))proved.set(command,{callId:id,originCallId:initial,source:finalSource,evidence:'literal immutable-script execution with observed zero exit'});
  }
  if(t.tool==='run_commands'&&fresh(id))for(const operation of Array.isArray(output)?output:[]){
   if(operation?.success!==true)continue;
   // Never infer successful children from a collector loop or masked shell.
   for(const command of commands(operation.query,root))proved.set(command,{callId:id,source:finalSource,evidence:'successful literal native operation'});
  }
 }
 return checks.map(c=>({id:c.id,command:'npm run '+c.task,passedOnFinalSource:proved.has('npm run '+c.task),proof:proved.get('npm run '+c.task)??null}));
}
