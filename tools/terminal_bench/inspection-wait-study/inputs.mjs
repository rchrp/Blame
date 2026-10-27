import assert from 'node:assert/strict';
import {readFile,mkdir,cp,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {checksFor,instruction as originalInstruction} from '../context-economy-study/inputs.mjs';
import {atomicJson,digest} from '../durable-campaign.mjs';
import {dependencyManifest} from '../isolated-node-environment.mjs';
export {checksFor};
export const repo=resolve(import.meta.dirname,'../../..'),work='/workspace/blame-study-runs/inspection-wait-f72',study=join(repo,'docs/experiments/light-harness-inspection-wait-f72-2026-10-27');
export const registration=JSON.parse(await readFile(join(study,'selection-registration.json'))),tasks=registration.panels.flatMap(p=>p.tasks.map(t=>({...t,panel:p.id})));
export const baselineModules=()=>join(repo,'.blame/research/inspection-wait-f72/dependencies-v5/node_modules');
export const instruction=task=>originalInstruction(task);
export async function prepareInputs(){
 await access(join(work,'input-manifest.json')).then(()=>{throw Error('Refuse replacing inputs')},e=>{if(e.code!=='ENOENT')throw e;});
 const parentStudy=join(repo,'docs/experiments/light-harness-declaration-order-f70-2026-10-27'),parentWork='/workspace/blame-study-runs/declaration-f70';
 assert.equal(JSON.parse(await readFile(join(parentStudy,'campaign-status.json'))).complete,true,'Wait for all F70 workers');
 const parent=JSON.parse(await readFile(join(parentStudy,'model-protocol.json'))),manifest={},images={};
 await mkdir(join(work,'inputs'),{recursive:true});await mkdir(join(work,'official'),{recursive:true});
 for(const task of tasks){
  const original=parent.inputs[task.id];assert.equal(digest(instruction(task)),original.instructionSha256,'F70 task specification must stay unchanged');
  await cp(join(parentWork,'inputs',task.id),join(work,'inputs',task.id),{recursive:true,verbatimSymlinks:true});
  const archive=join(parentWork,'inputs',task.id+'.tar.gz');assert.equal(digest(await readFile(archive)),original.archiveSha256);await cp(archive,join(work,'inputs',task.id+'.tar.gz'));manifest[task.id]=original;
  const old=parent.dependencies[task.id].modules,files=await dependencyManifest(old);assert.equal(digest(JSON.stringify(files)),parent.dependencies[task.id].manifestSha256);
  assert.ok(!Object.keys(files).some(k=>/^(?:\.vitest-cache|\.vite|\.cache)\//u.test(k)));
  await mkdir(join(baselineModules(task),'..'),{recursive:true});await cp(old,baselineModules(task),{recursive:true,verbatimSymlinks:true});
  for(const name of ['package.json','package-lock.json'])await cp(join(old,'..',name),join(baselineModules(task),'..',name));
  images[task.id]={cacheFree:true,manifestSha256:digest(JSON.stringify(await dependencyManifest(baselineModules(task)))),parentManifestSha256:parent.dependencies[task.id].manifestSha256};
  assert.equal(images[task.id].manifestSha256,images[task.id].parentManifestSha256);
  for(const suffix of ['.patch','-positive.patch']){const name=task.id+suffix,bytes=await readFile(join(parentWork,'official',name));assert.equal(digest(bytes),parent.oracleFiles[name]);await cp(join(parentWork,'official',name),join(work,'official',name));}
 }
 await atomicJson(join(work,'input-manifest.json'),manifest,{exclusive:true});await atomicJson(join(work,'dependency-images.json'),images,{exclusive:true});
 console.log('Copied the unchanged F70 task, original sources, official patches and cache-free pinned image.');
}
if(process.argv[1]===import.meta.filename)await prepareInputs();
