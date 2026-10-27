import assert from 'node:assert/strict';import {readFile,mkdir,cp,rm,access} from 'node:fs/promises';import {join,resolve} from 'node:path';
import {checksFor,instruction as previousInstruction} from '../context-economy-study/inputs.mjs';import {atomicJson,digest} from '../durable-campaign.mjs';import {dependencyManifest} from '../isolated-node-environment.mjs';
export {checksFor};export const repo=resolve(import.meta.dirname,'../../..'),work='/workspace/blame-study-runs/declaration-f70',study=join(repo,'docs/experiments/light-harness-declaration-order-f70-2026-10-27');
export const registration=JSON.parse(await readFile(join(study,'selection-registration.json'))),tasks=registration.panels.flatMap(p=>p.tasks.map(t=>({...t,panel:p.id})));
export const baselineModules=task=>join(repo,'.blame/research/declaration-order-f70',task.id==='mutation-callbacks'?'dependencies-v4':'dependencies-v5','node_modules');
export const instruction=task=>previousInstruction(task);
export async function prepareInputs(){
 await access(join(work,'input-manifest.json')).then(()=>{throw Error('Refuse replacing inputs')},e=>{if(e.code!=='ENOENT')throw e});
 const priorStudy=join(repo,'docs/experiments/light-harness-context-economy-f68-2026-10-27');assert.equal(JSON.parse(await readFile(join(priorStudy,'campaign-status.json'))).complete,true,'Prior 28 assignments must have finished');
 const prior=JSON.parse(await readFile(join(priorStudy,'model-protocol.json')));await mkdir(join(work,'inputs'),{recursive:true});await mkdir(join(work,'official'),{recursive:true});const manifest={},images={};
 for(const task of tasks){
  const source='/workspace/blame-study-runs/context-f68/inputs/'+task.id;await cp(source,join(work,'inputs',task.id),{recursive:true,verbatimSymlinks:true});const archive=source+'.tar.gz';assert.equal(digest(await readFile(archive)),prior.inputs[task.id].archiveSha256);await cp(archive,join(work,'inputs',task.id+'.tar.gz'));manifest[task.id]={...prior.inputs[task.id],parentInstructionSha256:prior.inputs[task.id].instructionSha256,instructionSha256:digest(instruction(task))};
  const oldModules=prior.dependencies[task.id].modules;assert.equal(digest(JSON.stringify(await dependencyManifest(oldModules))),prior.dependencies[task.id].manifestSha256,'Original cohort image was not restored');
  const to=join(baselineModules(task),'..');await mkdir(to,{recursive:true});await cp(oldModules,baselineModules(task),{recursive:true,verbatimSymlinks:true});for(const cache of ['.vitest-cache','.vite','.cache'])await rm(join(baselineModules(task),cache),{recursive:true,force:true});
  for(const name of ['package.json','package-lock.json'])await cp(join(oldModules,'..',name),join(to,name));const files=await dependencyManifest(baselineModules(task));assert.ok(!Object.keys(files).some(k=>/^(?:\.vitest-cache|\.vite|\.cache)\//u.test(k)));images[task.id]={cacheFree:true,files:Object.keys(files).length,manifestSha256:digest(JSON.stringify(files)),parentManifestSha256:prior.dependencies[task.id].manifestSha256};
  for(const suffix of ['.patch','-positive.patch'])await cp('/workspace/blame-study-runs/context-f68/official/'+task.id+suffix,join(work,'official',task.id+suffix));
 }
 await atomicJson(join(work,'input-manifest.json'),manifest,{exclusive:true});await atomicJson(join(work,'dependency-images.json'),images,{exclusive:true});console.log('Copied unchanged source inputs and clean pinned dependency images.');
}
if(process.argv[1]===import.meta.filename)await prepareInputs();
