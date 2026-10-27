// Independent finite behavior/type probes. Never copied to a model workspace.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=process.argv[2],id=process.argv[3],R=await import(pathToFileURL(join(root,'src/index.ts')));
const collect=source=>{const values=[],errors=[];let complete=0;const sub=source.subscribe({next:v=>values.push(v),error:e=>errors.push(e),complete:()=>complete++});return {values,errors,complete,closed:sub.closed}};
let typeSource;
if(id==='map-context'){
 const O=await import(pathToFileURL(join(root,'src/operators/index.ts')));assert.equal(R.mapWithContext,O.mapWithContext);
 for(let length=0;length<=10;length++){
  let factories=0;const op=R.mapWithContext(()=>{factories++;return {sum:0}},(v,c,i)=>{const before=c.sum;c.sum+=v;return [v,before,i]});
  const values=Array.from({length},(_,i)=>i-2);let sum=0;const expected=values.map((v,i)=>{const before=sum;sum+=v;return [v,before,i]});
  for(let repeat=1;repeat<=2;repeat++){assert.deepEqual(collect(R.of(...values).pipe(op)),{values:expected,errors:[],complete:1,closed:true});assert.equal(factories,repeat);}
 }
 const error=new Error('factory');assert.deepEqual(collect(R.EMPTY.pipe(R.mapWithContext(()=>{throw error},v=>v))).errors,[error]);
 let made=0,stopped=0;const source=new R.Observable(s=>{for(let i=1;i<=5&&!s.closed;i++){made++;s.next(i)}return()=>stopped++});
 const fail=collect(source.pipe(R.mapWithContext(()=>({}),v=>{if(v===2)throw error;return v})));assert.deepEqual(fail.values,[1]);assert.deepEqual(fail.errors,[error]);assert.equal(made,2);assert.equal(stopped,1);
 made=0;assert.deepEqual(collect(source.pipe(R.mapWithContext(()=>({}),v=>v),R.take(1))).values,[1]);assert.equal(made,1);
 const subject=new R.Subject(),indices=[],output=[];subject.pipe(R.mapWithContext(()=>({}), (v,c,i)=>{indices.push(i);if(v===1)subject.next(2);return v})).subscribe(v=>output.push(v));subject.next(1);subject.complete();assert.deepEqual(indices,[0,1]);assert.deepEqual(output,[2,1]);
 typeSource="import {of,Observable,mapWithContext} from '../src/index';const actual=of(1).pipe(mapWithContext(()=>({count:0}),(v:number,c,i)=>String(v+c.count+i)));const expected:Observable<string>=actual;type Item<T>=T extends Observable<infer V>?V:never;type Any<T>=0 extends (1&T)?true:false;const notAny:Any<Item<typeof actual>>=false;void expected;void notAny;";
}else if(id==='take-through'){
 const O=await import(pathToFileURL(join(root,'src/operators/index.ts')));assert.equal(R.takeThrough,O.takeThrough);
 for(let length=0;length<=10;length++)for(let limit=0;limit<=10;limit++){
  const values=Array.from({length},(_,i)=>i),indices=[];const op=R.takeThrough((v,i)=>{indices.push(i);return i<limit});
  for(const repeat of [1,2]){const result=collect(R.of(...values).pipe(op));assert.deepEqual(result.values,values.slice(0,limit+1));assert.equal(result.complete,1);assert.deepEqual(result.errors,[]);assert.equal(indices.length,Math.min(length,limit+1)*repeat);}
 }
 let made=0,stopped=0;const source=new R.Observable(s=>{for(let i=1;i<=5&&!s.closed;i++){made++;s.next(i)}return()=>stopped++});
 assert.deepEqual(collect(source.pipe(R.takeThrough(v=>v<2))).values,[1,2]);assert.equal(made,2);assert.equal(stopped,1);
 const error=new Error('predicate');assert.deepEqual(collect(R.of(1,2,3).pipe(R.takeThrough(v=>{if(v===2)throw error;return true}))),{values:[1],errors:[error],complete:0,closed:true});
 assert.deepEqual(collect(R.throwError(()=>error).pipe(R.takeThrough(()=>true))).errors,[error]);
 typeSource="import {of,Observable,takeThrough} from '../src/index';const actual=of(1).pipe(takeThrough((v:number,i)=>v+i<3));const expected:Observable<number>=actual;type Item<T>=T extends Observable<infer V>?V:never;type Any<T>=0 extends (1&T)?true:false;const notAny:Any<Item<typeof actual>>=false;void expected;void notAny;";
}else if(id==='clamp-items'){
 assert.equal(typeof R.normalizeRange,'function');assert.equal(typeof R.clampItems,'function');
 for(let lo=-4;lo<=4;lo++)for(let hi=lo;hi<=5;hi++){const range=R.normalizeRange(lo,hi),values=Object.freeze([-10,-1,0,1,10]);assert.deepEqual(range,{lower:lo,upper:hi});assert.deepEqual(R.clampItems(values,range),values.map(v=>Math.max(lo,Math.min(hi,v))));assert.deepEqual(values,[-10,-1,0,1,10]);assert.deepEqual(range,{lower:lo,upper:hi});}
 assert.throws(()=>R.normalizeRange(2,1),RangeError);for(const value of [NaN,Infinity,1.2,Number.MAX_SAFE_INTEGER+1]){assert.throws(()=>R.normalizeRange(value,2),TypeError);assert.throws(()=>R.normalizeRange(0,value),TypeError);assert.throws(()=>R.clampItems([value],{lower:0,upper:2}),TypeError);}
 typeSource="import {clampItems,normalizeRange} from '../src/index';const range:Readonly<{lower:number;upper:number}>=normalizeRange(0,3);const actual=clampItems([1,5] as const,range);const expected:number[]=actual;type Any<T>=0 extends (1&T)?true:false;const notAny:Any<typeof actual[number]>=false;void expected;void notAny;";
}else if(id==='quota'){
 assert.equal(typeof R.createQuota,'function');for(let limit=0;limit<=8;limit++)for(let amount=0;amount<=10;amount++){
  const first=R.createQuota(limit),second=R.createQuota(limit);assert.equal(first.tryTake(amount),amount<=limit);assert.equal(first.remaining,amount<=limit?limit-amount:limit);assert.equal(second.remaining,limit);const before=first.remaining;assert.equal(first.restore(amount),Math.min(limit,before+amount));assert.equal(first.remaining,Math.min(limit,before+amount));
 }
 const q=R.createQuota(3);assert.equal(q.tryTake(),true);assert.equal(q.remaining,2);assert.equal(q.restore(),3);
 for(const amount of [-1,NaN,Infinity,1.2,Number.MAX_SAFE_INTEGER+1]){assert.throws(()=>R.createQuota(amount),RangeError);assert.throws(()=>q.tryTake(amount),RangeError);assert.throws(()=>q.restore(amount),RangeError);assert.equal(q.remaining,3);}
 typeSource="import {createQuota} from '../src/index';const actual=createQuota(2);const n:number=actual.remaining;const b:boolean=actual.tryTake();const r:number=actual.restore();\n// @ts-expect-error remaining must be read-only\nactual.remaining=4;\ntype Any<T>=0 extends (1&T)?true:false;const notAny:Any<typeof actual>=false;void n;void b;void r;void notAny;";
}else throw Error('Unknown task '+id);
await mkdir(join(root,'.blame'),{recursive:true});await writeFile(join(root,'.blame/public-types.ts'),typeSource+'\n');const config=JSON.parse(await readFile(join(root,'.study/tsconfig.json'),'utf8'));config.compilerOptions.baseUrl=resolve(root);config.files=[join(root,'.blame/public-types.ts')];delete config.include;delete config.exclude;await writeFile(join(root,'.blame/public-types.json'),JSON.stringify(config));
const typed=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','.blame/public-types.json'],{cwd:root,encoding:'utf8',timeout:60000});assert.equal(typed.status,0,typed.stdout+typed.stderr);console.log('Independent bounded behavior, exports and public-type probes passed; not whole-project verification.');
