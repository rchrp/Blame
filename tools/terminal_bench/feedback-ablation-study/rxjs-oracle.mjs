// Independent finite behavior/type probes; never copied into worker inputs.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=process.argv[2],id=process.argv[3],name={'filter-map':'filterMap','map-with-previous':'mapWithPrevious','tap-first':'tapFirst'}[id];
const R=await import(pathToFileURL(join(root,'src/index.ts'))),O=await import(pathToFileURL(join(root,'src/operators/index.ts')));
assert.equal(typeof R[name],'function');assert.equal(R[name],O[name]);
const collect=(source)=>{const values=[],errors=[];let complete=0;const subscription=source.subscribe({next:v=>values.push(v),error:e=>errors.push(e),complete:()=>complete++});return {values,errors,complete,closed:subscription.closed};};
for(let length=0;length<=12;length++){
 const input=Array.from({length},(_,i)=>i-3),seen=[];
 const op=id==='filter-map'?R[name]((v,i)=>{seen.push([v,i]);return i%2?{keep:true,value:String(v)}:{keep:false};}):id==='map-with-previous'?R[name]((v,p,i)=>{seen.push([v,p,i]);return [v,p,i];}):R[name](v=>seen.push(v));
 const expected=id==='filter-map'?input.filter((_,i)=>i%2).map(String):id==='map-with-previous'?input.map((v,i)=>[v,input[i-1],i]):input;
 for(const repeat of [1,2]){
  const result=collect(R.of(...input).pipe(op));assert.deepEqual(result.values,expected);assert.equal(result.complete,1);assert.deepEqual(result.errors,[]);assert.equal(result.closed,true);
  if(id==='tap-first')assert.equal(seen.length,(length?1:0)*repeat);
 }
 if(id==='filter-map')assert.deepEqual(seen,[...input.map((v,i)=>[v,i]),...input.map((v,i)=>[v,i])]);
}
// Exceptions must stop a synchronous producer and run teardown exactly once.
const error=new Error('project failure');let produced=0,teardowns=0;
const source=new R.Observable(sub=>{for(let i=1;i<=4&&!sub.closed;i++){produced++;sub.next(i);}if(!sub.closed)sub.complete();return()=>teardowns++;});
const throwing=id==='filter-map'?R[name]((v)=>{if(v===2)throw error;return {keep:true,value:v};}):id==='map-with-previous'?R[name](v=>{if(v===2)throw error;return v;}):R[name](()=>{throw error;});
const failed=collect(source.pipe(throwing));assert.deepEqual(failed.errors,[error]);assert.equal(failed.complete,0);assert.deepEqual(failed.values,id==='tap-first'?[]:[1]);assert.equal(produced,id==='tap-first'?1:2);assert.equal(teardowns,1);
const upstreamError=new Error('upstream');let called=0;
const noValues=id==='filter-map'?R[name](v=>{called++;return {keep:true,value:v};}):id==='map-with-previous'?R[name](v=>{called++;return v;}):R[name](()=>called++);
assert.deepEqual(collect(R.throwError(()=>upstreamError).pipe(noValues)).errors,[upstreamError]);assert.equal(called,0);
let unsubscribed=0;
const plain=id==='filter-map'?R[name](v=>({keep:true,value:v})):id==='map-with-previous'?R[name](v=>v):R[name](()=>{});
assert.deepEqual(collect(new R.Observable(sub=>{for(let i=0;i<5&&!sub.closed;i++){unsubscribed++;sub.next(i);}return()=>{};}).pipe(plain,R.take(1))).values,[0]);assert.equal(unsubscribed,1);
// Source state advances before a user callback can reenter the same subscription.
const subject=new R.Subject(),calls=[],values=[];
const reentrant=id==='filter-map'?R[name]((v,i)=>{calls.push([v,i]);if(v===1)subject.next(2);return {keep:true,value:v};}):id==='map-with-previous'?R[name]((v,p,i)=>{calls.push([v,p,i]);if(v===1)subject.next(2);return v;}):R[name](v=>{calls.push(v);subject.next(2);});
subject.pipe(reentrant).subscribe(v=>values.push(v));subject.next(1);subject.complete();
assert.deepEqual(calls,id==='filter-map'?[[1,0],[2,1]]:id==='map-with-previous'?[[1,undefined,0],[2,1,1]]:[1]);assert.deepEqual(values,[2,1]);
await mkdir(join(root,'.blame'),{recursive:true});
const expression=id==='filter-map'?"of(1).pipe(filterMap((v:number)=>({keep:true as const,value:String(v)})))":id==='map-with-previous'?"of(1).pipe(mapWithPrevious((v:number,p:number|undefined,i:number)=>String(v+(p??0)+i)))":"of(1).pipe(tapFirst((v:number)=>{const n:number=v;void n;}))";
const outputType=id==='tap-first'?'number':'string';
await writeFile(join(root,'.blame/public-types.ts'),`import {of,Observable,${name}} from '../src/index';const actual=${expression};const expected:Observable<${outputType}>=actual;type Value<T>=T extends Observable<infer V>?V:never;type IsAny<T>=0 extends (1&T)?true:false;const notAny:IsAny<Value<typeof actual>>=false;void expected;void notAny;\n`);
const config=JSON.parse(await readFile(join(root,'.study/tsconfig.json'),'utf8'));config.compilerOptions.baseUrl=resolve(root);config.files=[resolve(root,'.blame/public-types.ts')];delete config.include;delete config.exclude;
await writeFile(join(root,'.blame/public-types.json'),JSON.stringify(config));const typed=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','.blame/public-types.json'],{cwd:root,encoding:'utf8',timeout:60000});assert.equal(typed.status,0,typed.stdout+typed.stderr);
console.log('Finite export, subscription isolation, index/state, error, teardown/unsubscribe and public-type probes passed. Not complete upstream verification.');
