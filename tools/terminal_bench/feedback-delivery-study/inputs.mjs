import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,cp,rm,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {confirmations,diagnostics,common} from './tasks.mjs';
import {prepare as prepareRxjs} from '../feedback-ablation-study/rxjs-fixtures.mjs';
import {dependencies,initialize,compilerOptions} from '../feedback-ablation-study/recovery-common.mjs';
import {atomicJson,digest} from '../durable-campaign.mjs';
export const repo=resolve(import.meta.dirname,'../../..'),work='/workspace/blame-study-runs/feedback-f65';
export const study=join(repo,'docs/experiments/light-harness-feedback-delivery-f65-2026-10-27');
export const tasks=[...confirmations.map(t=>({...t,panel:'F66'})),...diagnostics.map(t=>({...t,panel:'F67'}))];
export const checks=['regression','types','delivered'].map(id=>({id,task:'test:study:'+id})).concat({id:'delivered-types',task:'typecheck:delivered'});
export function instruction(task){return task.request+(task.panel==='F67'?' First reproduce the existing diagnostic by running exactly node node_modules/typescript/bin/tsc --noEmit -p tsconfig.check.json. This compiler invocation is distinct from the required project checks.':' Follow RxJS operator and subscriber conventions.')+common;}
const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
export async function prepareInputs(){
 await access(join(work,'input-manifest.json')).then(()=>{throw Error('Refuse replacing frozen inputs')},e=>{if(e.code!=='ENOENT')throw e});
 await mkdir(join(work,'inputs'),{recursive:true});const manifest={};
 for(const task of tasks){
  const root=join(work,'inputs',task.id);await mkdir(root,{recursive:true});
  if(task.panel==='F66')await prepareRxjs(root,'filter-map',false);
  else {
   await dependencies(root,false);await mkdir(join(root,'src'));await mkdir(join(root,'.study'));
   await save(join(root,'package.json'),{name:'typed-recovery-fixture',private:true,type:'module',packageManager:'npm@11.6.4',scripts:{'test:study:regression':'node node_modules/vitest/vitest.mjs run --config .study/vitest.config.mjs','test:study:types':'node node_modules/typescript/bin/tsc --noEmit -p .study/tsconfig.json','test:study:delivered':'node .study/delivered.mjs runtime','typecheck:delivered':'node .study/delivered.mjs types'}});
   await writeFile(join(root,'src/range.ts'),"export const defaultUpper: number = '10';\nexport function identity(value: number): number { return value; }\n");
   await writeFile(join(root,'src/index.ts'),"export { identity } from './range';\n");
   await writeFile(join(root,'src/original.test.ts'),"import {test,expect} from 'vitest';import {identity} from './index';test('existing identity',()=>expect(identity(3)).toBe(3));\n");
   await save(join(root,'.study/tsconfig.json'),{compilerOptions,include:['../src/**/*.ts'],exclude:['../src/**/*.test.ts']});
   await save(join(root,'tsconfig.check.json'),{compilerOptions,include:['src/**/*.ts']});
   await cp(join(repo,'tools/terminal_bench/feedback-ablation-study/rxjs-delivered.mjs'),join(root,'.study/delivered.mjs'));
  }
  const taskInfo=JSON.parse(await readFile(join(root,'.study/task.json'),'utf8').catch(()=>'{"originalTests":["src/original.test.ts"]}'));
  await save(join(root,'.study/task.json'),{id:task.id,sourceRoot:'src',originalTests:taskInfo.originalTests});
  const upstream=task.panel==='F66';
  const config=upstream?"import {fileURLToPath} from 'node:url';const root=new URL('../',import.meta.url);export default {resolve:{alias:"+JSON.stringify([['rxjs/operators','src/operators/index.ts'],['rxjs/testing','src/testing/index.ts'],['rxjs/ajax','src/ajax/index.ts'],['rxjs/webSocket','src/webSocket/index.ts'],['rxjs/fetch','src/fetch/index.ts'],['rxjs','src/index.ts']])+".map(([find,path])=>({find,replacement:fileURLToPath(new URL(path,root))}))},esbuild:{tsconfigRaw:{compilerOptions:{useDefineForClassFields:false}}},test:{globals:true,setupFiles:['.study/mocha-vitest-bridge.mjs'],include:['spec/operators/map-spec.ts','spec/operators/filter-spec.ts','spec/operators/pairwise-spec.ts','spec/operators/tap-spec.ts'],maxWorkers:1,fileParallelism:false,cache:false}};\n":"export default {test:{include:['src/original.test.ts'],maxWorkers:1,fileParallelism:false,cache:false}};\n";
  await writeFile(join(root,'.study/vitest.config.mjs'),config);
  await rm(join(root,'.git'),{recursive:true,force:true});await initialize(root);
  // A trailing-slash ignore pattern does not exclude a dependency symlink.
  execFileSync('git',['update-index','--force-remove','node_modules'],{cwd:root});
  await writeFile(join(root,'.git/info/exclude'),'.blame/\nnode_modules\n');
  execFileSync('git',['-c','user.name=Study','-c','user.email=study@example.invalid','commit','--amend','--no-edit','--quiet'],{cwd:root,env:{...process.env,GIT_AUTHOR_DATE:'2026-10-27T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-27T00:00:00Z'}});
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  assert.equal(execFileSync('git',['ls-files','node_modules'],{cwd:root,encoding:'utf8'}).trim(),'');
  const archive=join(work,'inputs',task.id+'.tar.gz');execFileSync('tar',['-czf',archive,'--exclude=node_modules','--exclude=.blame','-C',root,'.']);
  manifest[task.id]={head,archiveSha256:digest(await readFile(archive)),instructionSha256:digest(instruction(task)),requiredChecks:checks};
 }
 await atomicJson(join(work,'input-manifest.json'),manifest,{exclusive:true});return manifest;
}
if(process.argv[1]===import.meta.filename)console.log(JSON.stringify(await prepareInputs(),null,2));
