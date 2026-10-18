import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {repo,registration,dependencies,initialize,files,compilerOptions,executeCheck} from './recovery-common.mjs';
const common=' Work only in this complete pinned checkout. No remote history, prior solutions, artifacts or dependency installation. Preserve original tests, public APIs, manifests, locks, configuration and supplied checks. Follow internal operator/subscriber conventions. Add implementation under src/internal/operators, export from both src/index.ts and src/operators/index.ts, and add new src/*.test.ts tests using vitest. After the final source/test edit run npm run test:study:regression, npm run test:study:types and npm run test:study:delivered. Source compilation excludes tests; typecheck:delivered separately compiles new tests. Report exact commands, outcomes and coverage limits honestly.';
export const largeTasks=registration.confirmationPanel.tasks.map(t=>({...t,project:'rxjs',selected:[],instruction:t.request+common,requiredChecks:['regression','types','delivered'].map(id=>({id,task:'test:study:'+id}))}));
const study=join(repo,'docs/experiments/light-harness-rxjs-confirmation-f64-2026-10-19');
export async function prepare(root,id,isolated=false){
 const task=largeTasks.find(t=>t.id===id);assert.ok(task);await mkdir(root,{recursive:true});
 const archive=await readFile(join(study,'inputs/rxjs.tar.gz')).then(()=>join(study,'inputs/rxjs.tar.gz'),e=>{if(e.code==='ENOENT')return '/workspace/blame-study-runs/validation-recovery-inputs/rxjs.tar.gz';throw e;});
 execFileSync('tar',['-xzf',archive,'--strip-components=1','-C',root]);await dependencies(root,isolated);await mkdir(join(root,'.study'));
 const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));pkg.packageManager='npm@11.6.4';
 Object.assign(pkg.scripts,{'test:study:regression':'node node_modules/vitest/vitest.mjs run --config .study/vitest.config.mjs','test:study:types':'node node_modules/typescript/bin/tsc --noEmit -p .study/tsconfig.json','test:study:delivered':'node .study/delivered.mjs runtime','typecheck:delivered':'node .study/delivered.mjs types'});await writeFile(join(root,'package.json'),JSON.stringify(pkg,null,2)+'\n');
 const paths=await files(join(root,'src')),originalTests=paths.filter(p=>/\.(?:test|spec)(?:-d)?\.ts$/.test(p)).map(p=>'src/'+p);
 await writeFile(join(root,'.study/task.json'),JSON.stringify({...task,sourceRoot:'src',originalTests}));
 const upstream=JSON.parse(await readFile(join(root,'tsconfig.json'),'utf8'));
 await writeFile(join(root,'.study/tsconfig.json'),JSON.stringify({compilerOptions:{...compilerOptions,useDefineForClassFields:false,baseUrl:'..',paths:upstream.compilerOptions.paths},include:['../src/**/*.ts'],exclude:['../src/**/*.test.ts','../src/**/*.spec.ts']}));
 const aliases=[['rxjs/operators','src/operators/index.ts'],['rxjs/testing','src/testing/index.ts'],['rxjs/ajax','src/ajax/index.ts'],['rxjs/webSocket','src/webSocket/index.ts'],['rxjs/fetch','src/fetch/index.ts'],['rxjs','src/index.ts']].map(([find,p])=>({find,replacement:join(root,p)}));
 const config={resolve:{alias:aliases},esbuild:{tsconfigRaw:{compilerOptions:{useDefineForClassFields:false}}},test:{globals:true,setupFiles:['.study/mocha-vitest-bridge.mjs'],include:['spec/operators/map-spec.ts','spec/operators/filter-spec.ts','spec/operators/pairwise-spec.ts','spec/operators/tap-spec.ts'],maxWorkers:1,fileParallelism:false,cache:false}};
 await writeFile(join(root,'.study/vitest.config.mjs'),'export default '+JSON.stringify(config)+';\n');
 await cp(join(import.meta.dirname,'mocha-vitest-bridge.mjs'),join(root,'.study/mocha-vitest-bridge.mjs'));
 await cp(join(import.meta.dirname,'rxjs-delivered.mjs'),join(root,'.study/delivered.mjs'));await initialize(root);
}
export function check(root,name,id){return executeCheck(root,name,id,'rxjs-oracle.mjs');}
export async function positive(root,id){
 const name={'filter-map':'filterMap','map-with-previous':'mapWithPrevious','tap-first':'tapFirst'}[id];
 const signature=id==='filter-map'?"export function filterMap<T,R>(project:(value:T,index:number)=>{keep:true;value:R}|{keep:false}):OperatorFunction<T,R>":id==='map-with-previous'?"export function mapWithPrevious<T,R>(project:(value:T,previous:T|undefined,index:number)=>R):OperatorFunction<T,R>":"export function tapFirst<T>(next:(value:T)=>void):MonoTypeOperatorFunction<T>";
 const state=id==='filter-map'?'let index=0;':id==='map-with-previous'?'let index=0;let previous:T|undefined;':'let first=true;';
 const body=id==='filter-map'?'const result=project(value,index++);if(result.keep)subscriber.next(result.value);':id==='map-with-previous'?'const prev=previous;previous=value;const result=project(value,prev,index++);subscriber.next(result);':'if(first){first=false;next(value);}subscriber.next(value);';
 const src="import {OperatorFunction,MonoTypeOperatorFunction} from '../types';import {operate} from '../util/lift';import {createOperatorSubscriber} from './OperatorSubscriber';\n"+signature+"{return operate((source,subscriber)=>{"+state+"source.subscribe(createOperatorSubscriber(subscriber,value=>{"+body+"}));});}\n";
 await writeFile(join(root,'src/internal/operators',name+'.ts'),src);
 for(const [file,prefix] of [['src/index.ts','./internal/operators/'],['src/operators/index.ts','../internal/operators/']]){const path=join(root,file);await writeFile(path,await readFile(path,'utf8')+`\nexport { ${name} } from '${prefix}${name}';\n`);}
 await writeFile(join(root,'src/feature.test.ts'),`import {test,expect} from 'vitest';import {of,${name}} from './index';test('new operator export',()=>{expect(typeof ${name}).toBe('function');});\n`);
}
