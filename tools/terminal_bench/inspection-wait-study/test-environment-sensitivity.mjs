// Post-dispatch shadow compilation only; never changes frozen task/score/patch.
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,cp,chmod,lstat,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {evidence,file} from '../context-economy-study/evidence.mjs';
import {sourceEpoch} from './source-epoch.mjs';
import {study,work,repo} from './inputs.mjs';
import {digest,atomicJson} from '../durable-campaign.mjs';
import {dependencyManifest} from '../isolated-node-environment.mjs';
process.umask(0o077);
const cohorts=[];
for(const folder of ['context-economy-study','declaration-order-study','inspection-wait-study']){
 const inputs=await import('../'+folder+'/inputs.mjs'),restore=await import('../'+folder+'/restore-input.mjs');
 const data=await evidence({directory:inputs.study});assert.equal(data.executionFinished,true,'Wait for all measured workers');
 cohorts.push({folder,inputs,restore,...data});
}
const destination=join(work,'test-environment-sensitivity');await mkdir(destination,{recursive:true});
const registration=JSON.parse(await readFile(join(study,'upstream-test-environment-sensitivity.json')));
const setupPath='packages/react-query/test-setup.ts',rows=[];
function compiler(root,config){const r=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p',config],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,env:{...process.env,TZ:'UTC',npm_config_offline:'true'}});return {exitCode:r.status,signal:r.signal,error:r.error?.code??null,stdout:r.stdout,stderr:r.stderr};}
async function dependencies(root,cohort,task){const modules=cohort.inputs.baselineModules(task);assert.equal(digest(JSON.stringify(await dependencyManifest(modules))),cohort.protocol.dependencies[task.id].manifestSha256);await cp(modules,join(root,'node_modules'),{recursive:true,verbatimSymlinks:true});}
// A pure type fixture distinguishes original ambient bindings from a patch repair.
const current=cohorts.at(-1),task=current.inputs.tasks.find(t=>t.id==='fetching-filters');
const control=await mkdtemp(join(destination,'control-'));await current.restore.restoreInput(control,task.id,current.protocol,{portable:true});await dependencies(control,current,task);
await mkdir(join(control,'.study/reports'),{recursive:true});await writeFile(join(control,'.study/reports/matcher-fixture.ts'),"import {expect} from 'vitest';expect(document.createElement('div')).toBeInTheDocument();\n");
const base=JSON.parse(await readFile(join(control,'.study/source-tsconfig.json')));delete base.include;delete base.exclude;base.compilerOptions.paths=Object.fromEntries(Object.entries(base.compilerOptions.paths).map(([k,v])=>[k,v.map(p=>'../'+p)]));base.files=['./matcher-fixture.ts'];
await writeFile(join(control,'.study/reports/matcher-control.json'),JSON.stringify(base));const isolated=compiler(control,'.study/reports/matcher-control.json');
base.files.push('../../'+setupPath);await writeFile(join(control,'.study/reports/matcher-control.json'),JSON.stringify(base));const upstream=compiler(control,'.study/reports/matcher-control.json');
const setupSha256=digest(await readFile(join(control,setupPath)));assert.equal(setupSha256,registration.evidence.upstreamSetupSha256);
const controls={isolated,upstream,setupSha256,validated:isolated.exitCode!==0&&/error TS2339:.*toBeInTheDocument/u.test(isolated.stdout)&&upstream.exitCode===0};
await atomicJson(join(study,'upstream-test-environment-controls.json'),controls);assert.equal(controls.validated,true,'Keep failed scope controls; do not reinterpret outcomes');await rm(control,{recursive:true,force:true});
const expected=cohorts.reduce((n,c)=>n+c.records.filter(r=>r.row.task==='fetching-filters').length,0);
for(const c of cohorts){
 const task=c.inputs.tasks.find(t=>t.id==='fetching-filters');
 for(const trial of c.records.filter(r=>r.row.task==='fetching-filters')){
  const root=await mkdtemp(join(destination,c.folder+'-'+trial.name+'-'));await c.restore.restoreInput(root,task.id,c.protocol,{portable:true});
  const patch=file(trial,'workspace.diff');if(patch.length)execFileSync('git',['apply','--binary','--whitespace=nowarn','-'],{cwd:root,input:patch});
  let modes;
  if(trial.files['source-permissions.json'])modes=JSON.parse(file(trial,'source-permissions.json')).overrides;
  else{const archived=JSON.parse(await readFile(join(c.inputs.study,'source-permissions.json'))).trials[trial.name];assert.equal(archived.checkpointSha256,trial.receipt.sha256);modes=archived.overrides;}
  for(const [path,mode]of Object.entries(modes)){assert.ok(!path.startsWith('/')&&!path.split('/').includes('..'));try{if((await lstat(join(root,path))).isFile())await chmod(join(root,path),mode);}catch(e){if(e.code!=='ENOENT')throw e;}}
  const source=JSON.parse(file(trial,'source-at-exit.json')).sha256;assert.equal(sourceEpoch(root).sha256,source,'Exact unchanged source: '+trial.name);
  const setupUnchanged=digest(await readFile(join(root,setupPath)))===setupSha256;await dependencies(root,c,task);
  const raw=spawnSync(process.execPath,['.study/checks.mjs','delivered-types'],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,env:{...process.env,TZ:'UTC',npm_config_offline:'true'}});
  const original={exitCode:raw.status,signal:raw.signal,error:raw.error?.code??null,stdout:raw.stdout,stderr:raw.stderr};
  const frozen=trial.row.score.endpoints.find(e=>e.name==='delivered-types'),rawFrozen=JSON.parse(file(trial,'endpoints.json')).find(e=>e.name==='delivered-types');
  const diagnostics=s=>s.split('\n').filter(l=>/error TS[0-9]+:/u.test(l));
  const reproduced=original.exitCode===frozen.exitCode&&original.signal===frozen.signal&&JSON.stringify(diagnostics(original.stdout))===JSON.stringify(diagnostics(rawFrozen.stdout));
  let shadow=null;
  if(setupUnchanged&&trial.row.score.newTests.length){const config=JSON.parse(await readFile(join(root,'.study/reports/delivered-tsconfig.json')));config.files=[...new Set([...config.files,'../../'+setupPath])];await writeFile(join(root,'.study/reports/delivered-with-upstream-setup.json'),JSON.stringify(config));shadow=compiler(root,'.study/reports/delivered-with-upstream-setup.json');}
  assert.equal(sourceEpoch(root).sha256,source,'Shadow compilation must not change the model source.');
  const score=trial.row.score,guards=score.protectedPaths.length===0&&score.deleted.length===0&&score.symlinks.length===0&&score.dependencyComparison.pinnedDependenciesUnchanged;
  const sourceSensitivity=reproduced&&setupUnchanged&&shadow?guards&&score.endpoints.every(e=>e.name==='delivered-types'?shadow.exitCode===0:e.exitCode===0):null;
  rows.push({cohort:trial.row.panel,name:trial.name,patchSha256:digest(patch),exactSourceReconstructed:true,setupUnchanged,originalCompilerReproduced:reproduced,original,withOriginalSetup:shadow,frozenPrimarySourceSuccess:trial.row.sourceSuccess,sourceOnlySensitivity:sourceSensitivity,frozenPrimaryStrictSuccess:trial.row.strictSuccess,originalRequiredExecutionsConfirmed:trial.row.requiredInvocationsReported});
  await atomicJson(join(study,'upstream-test-environment-results.json'),{complete:rows.length===expected,expected,controls,rows,boundary:'Uniform shadow audit for every filtering assignment in its own cohort. Same exact patch/compiler/options, adding only original React setup to the delivered type-check file set. It is not full upstream repository typechecking. Primary scores, required tool execution proofs, SDK completion and formal admission stay unchanged. Independent compilation does not retroactively prove agent execution. All original diagnostics and adverse shadow changes are retained.'});
  console.log('ENVIRONMENT',trial.row.panel,trial.name,'isolated='+original.exitCode,'upstream='+shadow?.exitCode,'sourceSensitivity='+sourceSensitivity);
  if(reproduced)await rm(root,{recursive:true,force:true});
 }
}
