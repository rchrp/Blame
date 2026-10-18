import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {work,study,prepare,save,sha} from './setup.mjs';
import {tasks} from './tasks.mjs';
import {check,checkNames} from './checks.mjs';
import {panel} from './panels.mjs';
import * as large from './rxjs-fixtures.mjs';
import {LightWorkspace} from '../../../packages/agent-runtime/dist/harness/light-workspace.js';
await mkdir(study,{recursive:true});const rows=[];
for(const task of tasks){
 const root=join(work,'controls',task.id);await rm(root,{recursive:true,force:true});await prepare(root,task.id);
 if(panel.kind==='handoff'){
  const handoff=JSON.parse(await readFile(join(study,'handoffs',task.id+'.json'),'utf8'));
  const current=await new LightWorkspace(root,{sessionId:'identity-control'}).readCode({target:'@checks'},{});
  assert.equal(current.status,'ok');assert.equal(current.data.sourceRevisionId,handoff.edit.data.sourceRevisionId,'Handoff must bind the same HEAD and source bytes');assert.equal(current.data.checks.length,0,'Worker must not inherit seeded journal admission');
 }
 const before=checkNames.map(n=>check(root,n,task.id));assert.equal(before[0].exitCode,0,JSON.stringify(before[0]));
 if(panel.kind==='large')await large.positive(root,task.id);
 else {
  const p=join(root,'src/late.test.ts');await writeFile(p,(await readFile(p,'utf8')).replace('expected: number = "1"','expected: number = 1'));
  await writeFile(join(root,'src/independent.test.ts'),"import {test,expect} from 'vitest';import {value} from './value';test('numeric stable API',()=>expect(value+1).toBe(2));\n");
 }
 const after=checkNames.map(n=>check(root,n,task.id));assert.ok(after.every(c=>c.exitCode===0),JSON.stringify(after.filter(c=>c.exitCode!==0)));
 let patch=execFileSync('git',['diff','--binary','HEAD'],{cwd:root,encoding:'utf8'});
 for(const p of execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))patch+=spawnSync('git',['diff','--no-index','--binary','--','/dev/null',p],{cwd:root,encoding:'utf8'}).stdout;
 await writeFile(join(study,'positive-'+task.id+'.patch'),patch);
 if(panel.kind==='large'){
  const name={'filter-map':'filterMap','map-with-previous':'mapWithPrevious','tap-first':'tapFirst'}[task.id],p=join(root,'src/internal/operators',name+'.ts');let text=await readFile(p,'utf8');
  const state=task.id==='filter-map'?'let index=0;':task.id==='map-with-previous'?'let index=0;let previous:T|undefined;':'let first=true;';
  // Hoist only within the operator factory, preserving public types but sharing subscription state.
  assert.ok(text.includes(state));text=text.replace(state,'').replace('{return operate','{'+state+'return operate');await writeFile(p,text);
 }else{const p=join(root,'src/late.test.ts');await writeFile(p,(await readFile(p,'utf8')).replace('expected: number = 1','expected: number = "1"'));}
 const negative=check(root,'feature',task.id);assert.notEqual(negative.exitCode,0);
 const negativeTypes=check(root,'delivered-types',task.id);
 rows.push({task:task.id,before,after,negative,negativeTypes});console.log(task.id,'positive5/5','negative rejected');await rm(root,{recursive:true});
}
const names=['new-controls','recovery-common','recovery-fixtures','recovery-oracle','handoff-inputs','rxjs-fixtures','rxjs-oracle','rxjs-delivered','mocha-vitest-bridge','setup','tasks','panels','checks','delivered'];
await save(join(study,'oracle-controls.json'),{complete:true,modelRequests:0,method:'Unchanged full inputs and selected original regression cases. Independent positive controls pass all5 endpoints; state-hoisting or invalid-test mutants fail the finite oracle. Research solutions never enter model inputs.',rows,scriptHashes:Object.fromEntries(await Promise.all(names.map(async n=>[n+'.mjs',sha(await readFile(join(import.meta.dirname,n+'.mjs')))])))});
