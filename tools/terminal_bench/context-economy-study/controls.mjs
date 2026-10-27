import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,symlink,cp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {tasks,work,repo,baselineModules,checksFor} from './inputs.mjs';
import {endpoint as diagnosticEndpoint,positive as diagnosticPositive} from '../feedback-delivery-study/controls.mjs';
import {atomicJson,digest} from '../durable-campaign.mjs';
import {installProbe} from './probes.mjs';
const json = async p=>JSON.parse(await readFile(p));
export async function attachDependencies(root,task) {
  // Read-only original dependencies for independent grading, with Vite/TS
  // source aliases. Model workers instead get per-trial physical copies.
  await symlink(baselineModules(task),join(root,'node_modules'));
}
export async function endpoint(root,name,task) {
  if(task.panel==='F68')return diagnosticEndpoint(root,name==='official'?'oracle':name,task.id);
  let args;
  if(name==='regression')args=['.study/checks.mjs','regression'];
  else if(name==='types')args=['node_modules/typescript/bin/tsc','--noEmit','-p','.study/source-tsconfig.json'];
  else if(name==='delivered')args=['.study/checks.mjs','delivered'];
  else if(name==='delivered-types')args=['.study/checks.mjs','delivered-types'];
  else if(name==='type-regression')args=['node_modules/typescript/bin/tsc','--noEmit','-p','.study/type-tsconfig.json'];
  else if(name==='probe'){
    const path=await installProbe(root,task);
    if(task.id==='mutation-callbacks')args=['node_modules/vitest/vitest.mjs','run','--configLoader','native','--config','.study/vitest.config.mjs',path];
    else{const base=await json(join(root,'.study/source-tsconfig.json'));delete base.include;delete base.exclude;base.files=['../../'+path];base.compilerOptions.paths=Object.fromEntries(Object.entries(base.compilerOptions.paths).map(([k,v])=>[k,v.map(p=>'../'+p)]));await mkdir(join(root,'.study/reports'),{recursive:true});await writeFile(join(root,'.study/reports/probe-tsconfig.json'),JSON.stringify(base));args=['node_modules/typescript/bin/tsc','--noEmit','-p','.study/reports/probe-tsconfig.json'];}
  }
  else if(name==='official'&&task.id==='mutation-callbacks')args=['node_modules/vitest/vitest.mjs','run','--configLoader','native','--config','.study/vitest.config.mjs','packages/query-core/src/__tests__/mutationObserver.test.tsx'];
  else if(name==='official'){
    const base=await json(join(root,'.study/source-tsconfig.json'));delete base.include;delete base.exclude;
    base.files=['../../packages/query-core/src/__tests__/queryClient.test-d.tsx','../../packages/react-query/src/__tests__/useIsFetching.test-d.tsx'];
    base.compilerOptions.paths=Object.fromEntries(Object.entries(base.compilerOptions.paths).map(([k,v])=>[k,v.map(p=>'../'+p)]));
    await mkdir(join(root,'.study/reports'),{recursive:true});await writeFile(join(root,'.study/reports/official-tsconfig.json'),JSON.stringify(base));
    args=['node_modules/typescript/bin/tsc','--noEmit','-p','.study/reports/official-tsconfig.json'];
  }else throw Error('Unknown endpoint '+name);
  const started=performance.now(),r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,env:{...process.env,TZ:'UTC',npm_config_offline:'true'}});
  return {name,exitCode:r.status,signal:r.signal,error:r.error?.code??null,durationMs:performance.now()-started,stdout:r.stdout,stderr:r.stderr};
}
export async function applyOfficial(root,task) {
  if(task.panel!=='F68')execFileSync('git',['apply','--whitespace=nowarn','-'],{cwd:root,input:await readFile(join(work,'official',task.id+'.patch'))});
}
export async function positive(root,task) {
  if(task.panel==='F68')return diagnosticPositive(root,{...task,panel:'F67'});
  execFileSync('git',['apply','--whitespace=nowarn','-'],{cwd:root,input:await readFile(join(work,'official',task.id+'-positive.patch'))});
  if(task.id==='mutation-callbacks'){
    const original=await readFile(join(root,'packages/query-core/src/__tests__/mutationObserver.test.tsx'),'utf8');
    // The delivered control is separate from the unchanged official patch.
    await writeFile(join(root,'packages/query-core/src/__tests__/study-control.test.tsx'),original.replaceAll("describe('mutationObserver'","describe('delivered mutation observer'"));
  } else await writeFile(join(root,'packages/query-core/src/__tests__/study-control.test-d.ts'),"import {QueryClient} from '..';import {useIsFetching} from '@tanstack/react-query';const q=new QueryClient();const a:number=q.isFetching({queryKey:['x']});const b:number=useIsFetching({exact:true});\n// @ts-expect-error overridden internally\nq.isFetching({fetchStatus:'idle'});\n// @ts-expect-error overridden internally\nuseIsFetching({fetchStatus:'paused'});\nq.getQueryCache().findAll({fetchStatus:'idle'});void a;void b;\n");
}
if(process.argv[1]===import.meta.filename){
  await mkdir(join(work,'controls'),{recursive:true});const rows=[];
  for(const task of tasks){
    const root=await mkdtemp(join(work,'controls',task.id+'-'));execFileSync('tar',['-xzf',join(work,'inputs',task.id+'.tar.gz'),'-C',root]);await attachDependencies(root,task);
    let baseline,negativeProbe;
    if(task.panel==='F69'){
      await applyOfficial(root,task);baseline=await endpoint(root,'official',task);await atomicJson(join(root,'baseline-official.json'),baseline);
      assert.notEqual(baseline.exitCode,0,'Official regression must fail before fix: '+task.id);
      negativeProbe=await endpoint(root,'probe',task);assert.notEqual(negativeProbe.exitCode,0,'Independent probe must fail before fix');
      await rm(join(root,'packages/query-core/src/__tests__',task.id==='mutation-callbacks'?'study-hidden-error.test.ts':'study-hidden-filter.test-d.ts'));
      // Remove only the original official patch before delivered-control setup.
      execFileSync('git',['apply','--reverse','--whitespace=nowarn','-'],{cwd:root,input:await readFile(join(work,'official',task.id+'.patch'))});
    }
    await positive(root,task);
    const names=checksFor(task).map(c=>c.id),results=[];
    for(const name of names){const r=await endpoint(root,name,task);results.push(r);await atomicJson(join(root,name+'.json'),r);assert.equal(r.exitCode,0,task.id+' '+name+'\n'+r.stdout+'\n'+r.stderr);}
    // A distinct clone keeps authored test filenames from colliding with the
    // official test patch. Only production changes enter this official tree.
    const officialRoot=await mkdtemp(join(work,'controls',task.id+'-official-'));execFileSync('tar',['-xzf',join(work,'inputs',task.id+'.tar.gz'),'-C',officialRoot]);await attachDependencies(officialRoot,task);
    if(task.panel==='F68')await diagnosticPositive(officialRoot,{...task,panel:'F67'});
    else execFileSync('git',['apply','--whitespace=nowarn','-'],{cwd:officialRoot,input:await readFile(join(work,'official',task.id+'-positive.patch'))});
    await applyOfficial(officialRoot,task);const fixed=await endpoint(officialRoot,'official',task);await atomicJson(join(officialRoot,'official.json'),fixed);assert.equal(fixed.exitCode,0,task.id+' fixed official\n'+fixed.stdout+'\n'+fixed.stderr);
    const probe=task.panel==='F69'?await endpoint(officialRoot,'probe',task):null;if(probe){await atomicJson(join(officialRoot,'probe.json'),probe);assert.equal(probe.exitCode,0,'Positive independent probe: '+probe.stdout+'\n'+probe.stderr);}
    rows.push({task:task.id,knownDiagnostic:task.panel==='F68',baselineOfficial:baseline?{exitCode:baseline.exitCode}:null,negativeProbe:negativeProbe?{exitCode:negativeProbe.exitCode}:null,positive:results.map(({stdout,stderr,...r})=>r),official:{exitCode:fixed.exitCode},independentProbe:probe?{exitCode:probe.exitCode}:null,inputHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()});
    console.log('CONTROL',task.id,'passed');
  }
  await atomicJson(join(work,'controls.json'),{complete:true,externalModelRequests:0,rows,sourceHashes:{controls:digest(await readFile(import.meta.filename)),checks:digest(await readFile(join(import.meta.dirname,'project-checks.mjs')))}},{exclusive:true});
}
