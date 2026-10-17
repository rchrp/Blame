// Preserve malformed raw evidence and surface its uncertainty; never repair JSON.
import {readFile} from 'node:fs/promises';
import {sha} from './setup.mjs';
export function parseJsonLines(bytes){
 const rows=[],anomalies=[];
 for(const [index,line]of bytes.toString().split('\n').entries()){
  if(!line.trim())continue;
  try{const row=JSON.parse(line);if(!row||typeof row!=='object'||Array.isArray(row))anomalies.push({line:index+1,reason:'unexpected_row_type',bytes:Buffer.byteLength(line),sha256:sha(line)});else rows.push(row);}catch{anomalies.push({line:index+1,reason:'invalid_json',bytes:Buffer.byteLength(line),sha256:sha(line)});}
 }
 return{rows,anomalies};
}
export async function readJsonLines(path){
 try{return parseJsonLines(await readFile(path));}catch(error){if(error.code==='ENOENT')return{rows:[],anomalies:[{reason:'missing_file'}]};throw error;}
}
export async function readResult(path){
 try{const bytes=await readFile(path);try{const value=JSON.parse(bytes);if(!value||typeof value!=='object'||Array.isArray(value))return{value:{},anomalies:[{reason:'unexpected_result_type',bytes:bytes.length,sha256:sha(bytes)}]};return{value,anomalies:[]};}catch{return{value:{},anomalies:[{reason:'invalid_json',bytes:bytes.length,sha256:sha(bytes)}]};}}
 catch(error){if(error.code==='ENOENT')return{value:{},anomalies:[{reason:'missing_file'}]};throw error;}
}
export function finishObservation(tool,index){
 const output=tool.output,type=output===null?'null':Array.isArray(output)?'array':typeof output;
 const rejected=type==='object'&&(['blocked','failed','error'].includes(output.status)||output.success===false);
 const accepted=type==='string'||type==='object'&&(output.status==='ok'||output.success===true);
 return{index,outputType:type,classification:rejected?'rejected':accepted?'accepted':'unknown'};
}
