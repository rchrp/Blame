// Hidden finite oracle, outside worker inputs; includes native slice and explicit bound policy.
import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {spawnSync} from 'node:child_process';
const root=process.argv[2],id=process.argv[3],R=await import(pathToFileURL(join(root,'packages/remeda/src/index.ts')));let assertions=0;
const equal=(a,b)=>{assert.deepEqual(a,b);assertions++;};
const indexes=[NaN,-Infinity,-100,-4,-3.9,-2.5,-1,-0.5,-0,0,0.5,1,1.9,3,4.5,100,Infinity];
if(id==='suffix-counts')for(let length=0;length<7;length++)for(const n of indexes){
 const array=Object.freeze(Array.from({length},(_,i)=>i)),count=Number.isNaN(n)||n<=0?0:n===Infinity?length:Math.floor(n);
 const take=count===0?[]:Array.from(array).slice(-Math.min(length,count)),drop=Array.from(array).slice(0,length-Math.min(length,count));
 for(const actual of [R.takeLast(array,n),R.takeLast(n)(array),R.pipe(array,R.takeLast(n))]){equal(actual,take);assert.notEqual(actual,array);}
 for(const actual of [R.dropLast(array,n),R.dropLast(n)(array),R.pipe(array,R.dropLast(n))]){equal(actual,drop);assert.notEqual(actual,array);}
}else if(id==='reversed-clamp'){
 const values=[-Infinity,-5,-1,0,1,4,Infinity,NaN],bounds=[undefined,...values];
 for(const min of bounds)for(const max of bounds)for(const x of values){const limits=Object.freeze({...(min===undefined?{}:{min}),...(max===undefined?{}:{max})});let a=min,b=max;
 if(Number.isFinite(a)&&Number.isFinite(b)&&a>b)[a,b]=[b,a];
 const expected=a!==undefined&&x<a?a:b!==undefined&&x>b?b:x;
 for(const actual of [R.clamp(x,limits),R.clamp(limits)(x),R.pipe(x,R.clamp(limits))])equal(actual,expected);
 }
 const limits={min:4,max:1},curried=R.clamp(limits);equal(curried(2),2);limits.min=9;limits.max=5;equal(curried(2),5);equal(limits,{min:9,max:5});
}else if(id==='slice-index')for(let length=0;length<7;length++)for(const index of indexes){
 const array=Object.freeze(Array.from({length},(_,i)=>i)),expected=[array.slice(0,index),array.slice(index)];
 for(const actual of [R.splitAt(array,index),R.splitAt(index)(array),R.pipe(array,R.splitAt(index))]){equal(actual,expected);assert.notEqual(actual[0],array);assert.notEqual(actual[1],array);}
}else throw Error('Unknown task');
await mkdir(join(root,'.blame'),{recursive:true});await writeFile(join(root,'.blame/public-types.ts'),"import * as R from '../packages/remeda/src/index.ts';const a:readonly string[]=['a'];const t:string[]=R.takeLast(a,1);const d:string[]=R.dropLast(1)(a);const s:[string[],string[]]=R.splitAt(a,-.5);const c:number=R.clamp({min:4,max:1})(2);void t;void d;void s;void c;\n");
const {compilerOptions}=JSON.parse(await readFile(join(root,'.study/tsconfig.json'),'utf8'));await writeFile(join(root,'.blame/public-types.json'),JSON.stringify({compilerOptions,files:['public-types.ts']}));
const t=spawnSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','-p','.blame/public-types.json'],{cwd:root,encoding:'utf8',timeout:60000});assert.equal(t.status,0,t.stdout+t.stderr);
console.log('Finite behavioral/public types passed',id,assertions);
