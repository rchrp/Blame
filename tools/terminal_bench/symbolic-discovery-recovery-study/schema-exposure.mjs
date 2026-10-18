// Inspect the actual run_task JSON-Schema discriminator, never description text.
import assert from 'node:assert/strict';
import {sha} from './setup.mjs';
export function schemaExposure(bytes){
 const tools=JSON.parse(bytes.toString());assert.ok(Array.isArray(tools),'Expected an archived tool array');
 const entries=tools.filter(tool=>(tool.function?.name??tool.name)==='run_task');assert.ok(entries.length<=1,'Duplicate run_task schema');
 if(!entries.length)return{runTaskPresent:false,kinds:[],analyzeExposed:false,runTaskDescriptionSha256:null};
 const tool=entries[0].function??entries[0],kinds=new Set();
 function visit(schema){
  if(!schema||typeof schema!=='object')return;
  const kind=schema.properties?.kind;
  if(typeof kind?.const==='string')kinds.add(kind.const);
  if(Array.isArray(kind?.enum))for(const value of kind.enum)if(typeof value==='string')kinds.add(value);
  for(const key of ['oneOf','anyOf','allOf'])for(const child of schema[key]??[])visit(child);
 }
 visit(tool.parameters??tool.input_schema);
 assert.ok(kinds.size>0,'run_task discriminant not found; schema format requires review');
 return{runTaskPresent:true,kinds:[...kinds].sort(),analyzeExposed:kinds.has('analyze'),runTaskDescriptionSha256:sha(tool.description??'')};
}
