// Fast, model-free measurement controls; root runs outside live model workers.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {schemaExposure} from './schema-exposure.mjs';
import {parseJsonLines,finishObservation} from './evidence-io.mjs';
import {resourcesKnown,sumUsage,relativeDelta} from './resource-values.mjs';
import {study,save,sha} from './setup.mjs';
const good={contract:{unreported:0},usage:{tokensCostReconciled:true,input:100,output:10,cost:0.1}};
assert.equal(resourcesKnown(good),true);
const missing=[];
for(const key of ['input','output','cost'])for(const value of [null,undefined,NaN,Infinity,-1]){const row=structuredClone(good);row.usage[key]=value;assert.equal(resourcesKnown(row),false);missing.push({key,value:value===undefined?'undefined':Number.isNaN(value)?'NaN':value===Infinity?'Infinity':value});}
assert.equal(resourcesKnown({...good,contract:{unreported:1}}),false);assert.equal(resourcesKnown({...good,usage:{...good.usage,tokensCostReconciled:false}}),false);
assert.equal(relativeDelta(null,100),null);assert.equal(relativeDelta(100,null),null);assert.equal(relativeDelta(0,0),null);assert.equal(relativeDelta(100,50),1);assert.equal(sumUsage([{usage:{input:null}}],'input'),null);
const tools=kinds=>Buffer.from(JSON.stringify([{name:'run_task',description:'Example: {"kind":"analyze"}',parameters:{oneOf:kinds.map(kind=>({properties:{kind:{const:kind}}}))}}]));
assert.equal(schemaExposure(tools(['project'])).analyzeExposed,false);assert.equal(schemaExposure(tools(['project','analyze'])).analyzeExposed,true);assert.equal(schemaExposure(Buffer.from('[{"name":"run_commands"}]')).runTaskPresent,false);
const raw=Buffer.from('{"event":{"type":"done"}}\n{"event":{"type":"usage"}}\n{"event":');const parsed=parseJsonLines(raw);assert.equal(parsed.rows.length,2);assert.equal(parsed.anomalies.length,1);assert.equal(parsed.anomalies[0].line,3);
assert.equal(finishObservation({output:'Finished summary'},0).classification,'accepted');assert.equal(finishObservation({output:{status:'ok'}},0).classification,'accepted');assert.equal(finishObservation({output:{status:'blocked'}},0).classification,'rejected');assert.equal(finishObservation({output:null},0).classification,'unknown');
const files=['resource-values.mjs','schema-exposure.mjs','evidence-io.mjs','preflight-controls.mjs'];
await save(join(study,'preflight-controls.json'),{complete:true,modelRequests:0,missingResourceCases:missing.length,descriptionExampleIsNotSchemaExposure:true,truncatedTailPreserved:true,successfulStringFinishNotRejected:true,scriptHashes:Object.fromEntries(await Promise.all(files.map(async file=>[file,sha(await readFile(join(import.meta.dirname,file)))])))});
console.log('F53 measurement preflight controls passed; no model requests');
