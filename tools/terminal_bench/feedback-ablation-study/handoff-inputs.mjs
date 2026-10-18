// Actual local invocations/edits, serialized as an explicit research handoff.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,cp,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {repo,compilerOptions,dependencies,initialize,registration} from './recovery-common.mjs';
import {recoveryTasks} from './recovery-fixtures.mjs';
import {LightWorkspace} from '../../../packages/agent-runtime/dist/harness/light-workspace.js';
const study=join(repo,'docs/experiments/light-harness-validation-recovery-f63-2026-10-19'),base='/workspace/blame-study-runs/feedback-f63/seed-inputs';
const archive=join(study,'inputs/controlled-validation.tar.gz');
await access(archive).then(()=>{throw Error('Refuse replacing seeded inputs');},e=>{if(e.code!=='ENOENT')throw e;});
await mkdir(join(study,'handoffs'),{recursive:true});await mkdir(join(study,'inputs'),{recursive:true});
for(const task of recoveryTasks){
 const root=join(base,task.id);await rm(root,{recursive:true,force:true});await mkdir(join(root,'src'),{recursive:true});await mkdir(join(root,'.study'));
 const scripts={'test:unit':'node node_modules/vitest/vitest.mjs run --config .study/vitest.config.mjs','check:source':'node node_modules/typescript/bin/tsc --noEmit -p .study/tsconfig.json','test:study:delivered':'node .study/delivered.mjs runtime','typecheck:delivered':'node .study/delivered.mjs types'};
 await writeFile(join(root,'package.json'),JSON.stringify({name:'controlled-validation-handoff',private:true,type:'module',packageManager:'npm@11.6.4',scripts},null,2)+'\n');
 await writeFile(join(root,'src/value.ts'),'export const value: number = 1;\n');
 await writeFile(join(root,'src/base.test.ts'),"import {test,expect} from 'vitest';import {value} from './value';test('production value',()=>expect(value).toBe(1));\n");
 await writeFile(join(root,'src/late.test.ts'),"import {test,expect} from 'vitest';import {value} from './value';const expected: number = 1;test('expected value',()=>expect(value).toBe(Number(expected)));\n");
 // The provided late test participates in both runtime and the test compiler.
 await writeFile(join(root,'.study/task.json'),JSON.stringify({...task,sourceRoot:'src',originalTests:['src/base.test.ts']}));
 await writeFile(join(root,'.study/tsconfig.json'),JSON.stringify({compilerOptions,include:['../src/**/*.ts'],exclude:['../src/**/*.test.ts']}));
 await writeFile(join(root,'.study/types.ts'),"import {value} from '../src/value';const typed:number=value;void typed;\n");
 await writeFile(join(root,'.study/vitest.config.mjs'),'export default '+JSON.stringify({test:{include:['src/base.test.ts','src/late.test.ts'],maxWorkers:1,fileParallelism:false,cache:false}})+';\n');
 await cp(join(import.meta.dirname,'delivered.mjs'),join(root,'.study/delivered.mjs'));await dependencies(root,false);await initialize(root);
 const workspace=new LightWorkspace(root,{sessionId:'controlled-seed'}),earlierInvocations=[];
 for(const name of ['test:unit','check:source','typecheck:delivered']){
  const input={kind:'project',task:name},output=await workspace.runTask(input,{});assert.equal(output.status,'ok',JSON.stringify(output));
  earlierInvocations.push({input,output});
 }
 const path=task.id==='source-format'?'src/value.ts':'src/late.test.ts';const before=await readFile(join(root,path),'utf8');
 const after=task.id==='source-format'?before.replace('= 1;','=  1;'):before.replace('expected: number = 1','expected: number = "1"');assert.notEqual(after,before);
 const edit=await workspace.editCode({operations:[{kind:'patch',path,patch:'*** Begin Patch\n*** Update File: '+path+'\n@@\n-'+before.trimEnd()+'\n+'+after.trimEnd()+'\n*** End Patch'}]});
 assert.equal(edit.status,'ok',JSON.stringify(edit));assert.ok(edit.data.validationState);assert.ok(edit.data.validationState.invalidatedChecks.some(c=>c.task==='typecheck:delivered'));
 const laterInvocation=task.id==='wrapper-mode-argument'?{input:{kind:'project',task:'test:study:delivered',args:['types']}}:null;
 if(laterInvocation){laterInvocation.output=await workspace.runTask(laterInvocation.input,{});assert.equal(laterInvocation.output.status,'ok');assert.ok(laterInvocation.output.data.check.counts.executed>0);}
 // Capture the supplied post-edit tree for endpoint diffs without moving HEAD:
 // source identity includes HEAD, so preserving only file bytes is insufficient.
 execFileSync('git',['add','.'],{cwd:root});const tree=execFileSync('git',['write-tree'],{cwd:root,encoding:'utf8'}).trim();
 const commit=execFileSync('git',['-c','user.name=Study','-c','user.email=study@example.invalid','commit-tree',tree,'-p','HEAD','-m','Controlled input snapshot; no solution'],{cwd:root,encoding:'utf8',env:{...process.env,GIT_AUTHOR_DATE:'2026-10-19T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-19T00:00:00Z'}}).trim();execFileSync('git',['update-ref','refs/study/input',commit],{cwd:root});
 await writeFile(join(study,'handoffs',task.id+'.json'),JSON.stringify({task:task.id,earlierInvocations,edit,...(laterInvocation?{laterInvocation}:{})},null,2)+'\n');
}
execFileSync('tar',['-czf',archive,'--exclude=node_modules','--exclude=.blame','-C',base,...registration.controlledPanel.cases]);
console.log('Three actual passed-validation/post-edit handoffs frozen; no model calls and no restored worker journal.');
