// Kept outside the model workspace. Finite endpoint behavior plus public-type probes.
import assert from 'node:assert/strict';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {spawnSync} from 'node:child_process';
const root=process.argv[2],id=process.argv[3],{P,match,isMatching}=await import(pathToFileURL(join(root,'src/index.ts')));let assertions=0;
const eq=(a,b)=>{assert.deepEqual(a,b);assertions++;};
if(id==='alternative-selections'){
 for(const n of [0,1,-1,7]){
  const value=Object.freeze({a:n,b:2});
  const first={a:P.select('discard'),b:0},second={a:n,b:P.select('keep')};
  eq(match(value).with(first,second,s=>s).run(),{keep:2});
  eq(match(value).with(P.union(first,second),s=>s).run(),{discard:undefined,keep:2});
  let calls=0;eq(isMatching(P.union(first,second,P.when(()=>{calls++;return true;})),value),true);eq(calls,0);
  eq(match(value).with(first,second,()=>3).otherwise(()=>4),3);
  eq(match(value).with(first,()=>3).otherwise(()=>4),4);
  eq(match(value).with(P.union({a:P.select(),b:0},{a:n,b:P.select()}),s=>s).run(),2);
 }
 const p=P.union({a:P.select('x'),b:0},{a:0,b:P.select('y')});
 const raw=p[P.matcher]().match({a:1,b:2});eq(raw.matched,false);for(const value of Object.values(raw.selections??{}))eq(value,undefined);
 let called=0;eq(match({a:1,b:2}).with({a:P.select('x')},()=>{called++;return false;},()=>3).otherwise(()=>4),4);eq(called,1);
}else if(id==='symbol-pattern-keys'){
 for(const key of [Symbol('key'),'hidden']){
  const p={};Object.defineProperty(p,key,{value:P.select('x'),enumerable:false});
  eq(match(undefined).with(P.optional(p),s=>s).run(),{x:undefined});
  eq(match([]).with(P.array(p),s=>s).run(),{x:[]});
  const v=Object.create({[key]:7});eq(match(v).with(p,s=>s).run(),{x:7});
  eq(isMatching(p,{[key]:'ok'}),true);
  const inherited=Object.create({ignored:P.select('discard')});Object.defineProperty(inherited,key,{value:P.select('keep'),enumerable:false});
  eq(match(undefined).with(P.optional(inherited),s=>s).run(),{keep:undefined});
  eq(match({[key]:3}).with(inherited,s=>s).run(),{keep:3});
 }
 eq(match([]).with(P.array([P.select('x')]),s=>s).run(),{x:[]});
}else if(id==='empty-collection-selections'){
 for(const p of [P.array(P.select('x')),P.set(P.select('x')),P.map(P.select('x'),P.select('y')),P.map(P.select('x'),P.select('x')),P.set({a:P.select('x')})]){
  const v=p===undefined?[]:p[P.matcher]().getSelectionKeys();
  const value=v.length===2&&v.includes('y')||p[P.matcher]().match(new Map()).matched?new Map():p[P.matcher]().match(new Set()).matched?new Set():[];
  const expected=Object.fromEntries(p[P.matcher]().getSelectionKeys().map(k=>[k,[]]));
  const first=match(value).with(p,s=>s).run(),second=match(value).with(p,s=>s).run();eq(first,expected);eq(second,expected);
  if('x' in first){assert.notEqual(first.x,second.x);first.x.push('mutation');eq(second.x,[]);}
 }
 eq(match(new Set()).with(P.set(P.select()),s=>s).run(),[]);
 eq(match(new Map()).with(P.map(P.select(),P.number),s=>s).run(),[]);
 eq(match(new Set([2,1])).with(P.set(P.select('x')),s=>s).run(),{x:[2,1]});
 eq(match(new Map([[2,'b'],[1,'a']])).with(P.map(P.select('k'),P.select('v')),s=>s).run(),{k:[2,1],v:['b','a']});
 eq(isMatching(P.set(),new Set()),true);eq(isMatching(P.map(),new Map()),true);eq(isMatching(P.array(),[]),true);
}else throw Error('Unknown task');
await mkdir(join(root,'.blame'),{recursive:true});
await writeFile(join(root,'.blame/public-types.ts'),`import {P,match,isMatching} from '../src/index';
const n:number=match<unknown>([1]).with(P.array(P.number), xs=>xs[0]??0).otherwise(()=>0);
const s:number[]=match<unknown>(new Set([1])).with(P.set(P.number),xs=>[...xs]).otherwise(()=>[]);
const m:Map<string,number>=match<unknown>(new Map()).with(P.map(P.string,P.number),xs=>xs).otherwise(()=>new Map<string,number>());
const guard=isMatching({x:P.number});const value:unknown={x:1};if(guard(value)){const x:number=value.x;void x;}
// @ts-expect-error Input handler must retain the matched type.
const invalid:string=match(1).with(P.number,x=>x).run();void n;void s;void m;void invalid;
`);
const {compilerOptions}=JSON.parse(await readFile(join(root,'.study/tsconfig.json'),'utf8'));await writeFile(join(root,'.blame/public-types.json'),JSON.stringify({compilerOptions,files:['public-types.ts']}));
const r=spawnSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','-p','.blame/public-types.json'],{cwd:root,encoding:'utf8',timeout:60000});assert.equal(r.status,0,r.stdout+r.stderr);
console.log('Finite behavior/public types passed',id,assertions);
