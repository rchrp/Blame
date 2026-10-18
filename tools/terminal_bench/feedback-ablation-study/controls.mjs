import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {work,study,prepare,save,sha} from './setup.mjs';
import {tasks} from './tasks.mjs';
import {positive,negative} from './solutions.mjs';
import {check,checkNames} from './checks.mjs';
import {panel} from './panels.mjs';
await mkdir(join(work,'controls'),{recursive:true});const rows=[];
for(const task of tasks){
 const root=join(work,'controls',task.id);await prepare(root,task.id);
 const before=checkNames.map(n=>check(root,n,task.id));await positive(root,task.id);
 const after=checkNames.map(n=>check(root,n,task.id));
 let patch=execFileSync('git',['diff','--binary','HEAD'],{cwd:root,encoding:'utf8'});
 for(const path of execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean)){const p=spawnSync('git',['diff','--no-index','--binary','--','/dev/null',path],{cwd:root,encoding:'utf8'});assert.equal(p.status,1);patch+=p.stdout;}
 await writeFile(join(study,'positive-'+task.id+'.patch'),patch);
 let optionalFailureSelections=null,relativeBoundaryControl=null;
 if(panel.id==='F62'){
  const runOnly=()=>{const r=spawnSync(process.execPath,['--import',join(root,'node_modules/tsx/dist/loader.mjs'),join(import.meta.dirname,'boundary-oracle.mjs'),root,task.id,'--boundary-only'],{cwd:root,encoding:'utf8',timeout:60000});return {exitCode:r.status,stdout:r.stdout,stderr:r.stderr};};
  const accepted=runOnly();assert.equal(accepted.exitCode,0,accepted.stdout+accepted.stderr);
  if(task.id==='suffix-counts'){
   const originals={};for(const name of ['takeLast','dropLast']){
    const path=join(root,'packages/remeda/src',name+'.ts'),text=await readFile(path,'utf8');originals[path]=text;
    const mutant=text.replaceAll('Math.max(0,array.length-count)','array.length-count');assert.notEqual(mutant,text);await writeFile(path,mutant);
   }
   const rejected=runOnly();assert.notEqual(rejected.exitCode,0);relativeBoundaryControl={accepted,rejected};
   for(const [path,text]of Object.entries(originals))await writeFile(path,text);
  }else relativeBoundaryControl={accepted};
 }
 if(task.id==='alternative-selections'){
  const path=join(root,'src/patterns.ts'),original=await readFile(path,'utf8'),start=original.indexOf('export function union<'),end=original.indexOf('export function not<',start);
  const change=expression=>original.slice(0,start)+original.slice(start,end).replace('return { matched, selections };',expression)+original.slice(end);
  const omitted=change('return matched ? {matched,selections} : {matched:false};');assert.notEqual(omitted,original);await writeFile(path,omitted);
  const accepted=checkNames.map(name=>check(root,name,task.id));assert.ok(accepted.every(c=>c.exitCode===0),JSON.stringify(accepted));
  const leaked=change('return matched ? {matched,selections} : {matched:false,selections:{x:1}};');await writeFile(path,leaked);
  const rejected=check(root,'feature',task.id);assert.notEqual(rejected.exitCode,0);
  optionalFailureSelections={protocol:'MatchResult.selections?: Record<string, any>, upstream src/types/Pattern.ts',acceptedOmittedSelection:accepted,rejectedFalseOnlyLeak:rejected,sourceHashes:{original:sha(original),omitted:sha(omitted),leaked:sha(leaked)}};
  await writeFile(path,original);
 }
 await negative(root,task.id);const semanticNegative=checkNames.map(n=>check(root,n,task.id));
 rows.push({task:task.id,before,after,semanticNegative,...(optionalFailureSelections?{optionalFailureSelections}:{}),...(relativeBoundaryControl?{relativeBoundaryControl}:{})});await save(join(study,'oracle-controls.json'),{complete:false,modelRequests:0,rows});
 console.log(task.id,JSON.stringify({before:before.map(c=>c.exitCode),after:after.map(c=>c.exitCode),negative:semanticNegative.map(c=>c.exitCode)}));
 assert.equal(before.find(c=>c.name==='regression').exitCode,0);assert.notEqual(before.find(c=>c.name==='feature').exitCode,0);
 assert.ok(after.every(c=>c.exitCode===0),JSON.stringify(after.filter(c=>c.exitCode!==0)));
 // Mutants may also be caught by an upstream test; the hidden oracle must reject them.
 assert.notEqual(semanticNegative.find(c=>c.name==='feature').exitCode,0);
 await rm(root,{recursive:true});
}
const files=['controls','setup','tasks','delivered','oracle','checks','solutions','panels','ts-pattern','ts-pattern-oracle','ts-pattern-delivered',...(panel.id==='F62'?['boundary-oracle']:[])];
await save(join(study,'oracle-controls.json'),{complete:true,modelRequests:0,method:'Pristine inputs preserve regression success but fail requested behavior; independent positive controls satisfy all checks; semantic mutations preserve original regression tests and are rejected by the hidden oracle. No control solution enters model workspaces.',scriptHashes:Object.fromEntries(await Promise.all(files.map(async n=>[n+'.mjs',sha(await readFile(join(import.meta.dirname,n+'.mjs')))]))),rows});
