import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {tasks,work,repo} from './inputs.mjs';
import {atomicJson,digest} from '../durable-campaign.mjs';
const deps=join(repo,'.blame/research/validation-recovery-f63/dependencies/node_modules');
export function endpoint(root,name,id){
 const argv=name==='oracle'?['--import',join(root,'node_modules/tsx/dist/loader.mjs'),join(import.meta.dirname,'oracle.mjs'),root,id]:[name==='types'?'node_modules/typescript/bin/tsc':name==='regression'?'node_modules/vitest/vitest.mjs':'.study/delivered.mjs',...(name==='types'?['--noEmit','-p','.study/tsconfig.json']:name==='regression'?['run','--config','.study/vitest.config.mjs']:[name==='delivered'?'runtime':'types'])];
 const started=performance.now(),r=spawnSync(process.execPath,argv,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,TZ:'UTC',npm_config_offline:'true',npm_config_update_notifier:'false'}});
 return {name,exitCode:r.status,signal:r.signal,error:r.error?.code??null,durationMs:performance.now()-started,stdout:r.stdout,stderr:r.stderr};
}
export async function positive(root,task){
 const modules={
 'map-context':"import {OperatorFunction} from '../types';import {operate} from '../util/lift';import {createOperatorSubscriber} from './OperatorSubscriber';export function mapWithContext<T,C,R>(createContext:()=>C,project:(v:T,c:C,i:number)=>R):OperatorFunction<T,R>{return operate((source,subscriber)=>{const context=createContext();let index=0;source.subscribe(createOperatorSubscriber(subscriber,value=>subscriber.next(project(value,context,index++))));});}\n",
 'take-through':"import {MonoTypeOperatorFunction} from '../types';import {takeWhile} from './takeWhile';export function takeThrough<T>(predicate:(v:T,i:number)=>boolean):MonoTypeOperatorFunction<T>{return takeWhile(predicate,true);}\n",
 'clamp-items':"import {normalizeRange} from './range';export function clampItems(values:readonly number[],range:Readonly<{lower:number;upper:number}>):number[]{const {lower,upper}=normalizeRange(range.lower,range.upper);return values.map(value=>{if(!Number.isSafeInteger(value))throw new TypeError('Expected safe integer');return Math.max(lower,Math.min(upper,value));});}\n",
 'quota':"export function createQuota(limit:number){const check=(n:number)=>{if(!Number.isSafeInteger(n)||n<0)throw new RangeError('Expected nonnegative safe integer');};check(limit);let remaining=limit;return {get remaining(){return remaining;},tryTake(amount=1){check(amount);if(amount>remaining)return false;remaining-=amount;return true;},restore(amount=1){check(amount);remaining=Math.min(limit,remaining+amount);return remaining;}};}\n"};
 const file=task.panel==='F66'?'src/internal/operators/'+task.name+'.ts':'src/'+(task.id==='quota'?'quota':'list')+'.ts';
 await writeFile(join(root,file),modules[task.id]);
 if(task.panel==='F67')await writeFile(join(root,'src/range.ts'),"export const defaultUpper: number = 10;export function identity(value:number){return value;}export function normalizeRange(lower:number,upper:number):Readonly<{lower:number;upper:number}>{if(!Number.isSafeInteger(lower)||!Number.isSafeInteger(upper))throw new TypeError('Expected safe integer');if(lower>upper)throw new RangeError('Reversed range');return Object.freeze({lower,upper});}\n");
 const exported=task.id==='clamp-items'?"export {normalizeRange} from './range';export {clampItems} from './list';":`export {${task.name}} from '${task.panel==='F66'?'./internal/operators/':'./'}${task.panel==='F66'?task.name:'quota'}';`;
 await writeFile(join(root,'src/index.ts'),await readFile(join(root,'src/index.ts'),'utf8')+'\n'+exported+'\n');
 if(task.panel==='F66')await writeFile(join(root,'src/operators/index.ts'),await readFile(join(root,'src/operators/index.ts'),'utf8')+`\nexport {${task.name}} from '../internal/operators/${task.name}';\n`);
 const expressions={'map-context':"const values:number[]=[];of(1,2).pipe(mapWithContext(()=>({n:0}),(v:number,c)=>c.n+=v)).subscribe(v=>values.push(v));expect(values).toEqual([1,3]);",'take-through':"const values:number[]=[];of(1,2,3).pipe(takeThrough((v:number)=>v<2)).subscribe(v=>values.push(v));expect(values).toEqual([1,2]);",'clamp-items':"expect(clampItems([-2,5],normalizeRange(0,3))).toEqual([0,3]);",'quota':"const q=createQuota(3);expect(q.tryTake(2)).toBe(true);expect(q.remaining).toBe(1);expect(q.restore(5)).toBe(3);"};
 await writeFile(join(root,'src/feature.test.ts'),"import {test,expect} from 'vitest';import {"+(task.panel==='F66'?'of,':'')+(task.id==='clamp-items'?'clampItems,normalizeRange':task.name)+"} from './index';test('feature behavior',()=>{"+expressions[task.id]+"});\n");return file;
}
if(process.argv[1]===import.meta.filename){
 await mkdir(join(work,'controls'),{recursive:true});const rows=[];
 for(const task of tasks){
  const root=await mkdtemp(join(work,'controls',task.id+'-'));execFileSync('tar',['-xzf',join(work,'inputs',task.id+'.tar.gz'),'-C',root]);await symlink(deps,join(root,'node_modules'));
  const file=await positive(root,task),results=['regression','types','delivered','delivered-types','oracle'].map(name=>endpoint(root,name,task.id));
  await atomicJson(join(root,'positive-checks.json'),results);for(const r of results)assert.equal(r.exitCode,0,task.id+' '+r.name+'\n'+r.stdout+'\n'+r.stderr);
  let source=await readFile(join(root,file),'utf8');
  if(task.id==='map-context')source=source.replace('return operate((source,subscriber)=>{const context=createContext();let index=0;','const context=createContext();let index=0;return operate((source,subscriber)=>{');
  else if(task.id==='take-through')source=source.replace('takeWhile(predicate,true)','takeWhile(predicate,false)');
  else if(task.id==='clamp-items')source=source.replace('Math.max(lower,Math.min(upper,value))','value');
  else source=source.replace('export function createQuota','function buildQuota')+"let shared:ReturnType<typeof buildQuota>|undefined;export const createQuota=(limit:number)=>shared??=(buildQuota(limit));\n";
  await writeFile(join(root,file),source);const negative=endpoint(root,'oracle',task.id);assert.notEqual(negative.exitCode,0,'Oracle accepted '+task.id+' mutant');
  rows.push({task:task.id,positive:results.map(({stdout,stderr,...r})=>r),negative:{...negative,stdout:undefined,stderr:undefined},sourceMutantSha256:digest(source)});
 }
 const report={complete:true,externalModelRequests:0,rows,hashes:{oracle:digest(await readFile(join(import.meta.dirname,'oracle.mjs'))),controls:digest(await readFile(import.meta.filename))}};
 await atomicJson(join(work,'controls.json'),report,{exclusive:true});console.log('All four correct controls pass five endpoints; four behavioral mutants rejected.');
}
