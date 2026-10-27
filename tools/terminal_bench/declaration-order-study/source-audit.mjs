import {appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {sourceEpoch} from './source-epoch.mjs';
const destination=process.env.BLAME_STUDY_SOURCE_AUDIT,root=process.env.BLAME_STUDY_WORKSPACE;
if(!destination||!root)throw Error('Explicit source audit paths required');
const {JsonlEventRecorder}=await import(pathToFileURL(process.env.BLAME_STUDY_FROZEN_RECORDER).href),record=JsonlEventRecorder.prototype.record;
JsonlEventRecorder.prototype.record=function(event){
 if(event.type==='tool'&&['started','finished'].includes(event.payload?.phase)){
  const started=performance.now();let epoch,error;
  try{epoch=sourceEpoch(root);}catch(e){error=e.code??e.name;}
  appendFileSync(destination,JSON.stringify({atUTC:new Date().toISOString(),phase:event.payload.phase,callId:event.payload.toolCallId??event.payload.toolCall?.id??null,tool:event.payload.toolCall?.name??event.payload.tool??null,epoch:epoch??null,error:error??null,observationMs:performance.now()-started})+'\n');
 }
 return record.call(this,event);
};
