// F62's common finite additions; historical F59/F60 oracles remain unchanged.
// Expectations follow explicit public task requests, never candidate helper names.
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
if(process.argv[4]!=='--boundary-only')await import('./oracle.mjs');
const root=process.argv[2],task=process.argv[3],R=await import(pathToFileURL(join(root,'packages/remeda/src/index.ts')));
let assertions=0;
const equal=(a,b)=>{assert.deepEqual(a,b);assertions++;};
if(task==='suffix-counts'||task==='slice-index')for(let length=0;length<=24;length++) {
  const input=Object.freeze(Array.from({length},(_,i)=>({id:i}))),before=[...input];
  const thresholds=[0,1,length,length+1,2*length,-length,-length-1];
  const values=[...new Set([NaN,Infinity,-Infinity,-0,Number.MAX_SAFE_INTEGER,-Number.MAX_SAFE_INTEGER,
    ...thresholds.flatMap(n=>[n-1,n-.5,n-.25,n-Number.EPSILON*Math.max(1,Math.abs(n)),n,n+Number.EPSILON*Math.max(1,Math.abs(n)),n+.25,n+.5,n+1])])];
  for(const n of values) {
    if(task==='suffix-counts') {
      const count=Number.isNaN(n)||n<=0?0:n===Infinity?length:Math.min(length,Math.floor(n));
      const take=input.slice(length-count),drop=input.slice(0,length-count);
      for(const [actual,expected]of [[R.takeLast(input,n),take],[R.takeLast(n)(input),take],[R.pipe(input,R.takeLast(n)),take],
        [R.dropLast(input,n),drop],[R.dropLast(n)(input),drop],[R.pipe(input,R.dropLast(n)),drop]]) {
        equal(actual,expected);assert.notEqual(actual,input);
      }
    } else for(const actual of [R.splitAt(input,n),R.splitAt(n)(input),R.pipe(input,R.splitAt(n))]) {
      equal(actual,[input.slice(0,n),input.slice(n)]);assert.notEqual(actual[0],input);assert.notEqual(actual[1],input);
    }
    equal(input,before);
  }
} else if(task==='reversed-clamp') {
  const limits={min:4,max:1},curried=R.clamp(limits);
  for(const [min,max]of [[4,1],[9,5],[-2,-8],[0,-0],[undefined,3],[NaN,2],[Infinity,-Infinity],[1,4]]) {
    if(min===undefined)delete limits.min;else limits.min=min;limits.max=max;
    for(const value of [-Infinity,-9,-8.25,-8,-7.75,-2.25,-2,-1.75,-0,0,.25,.75,1,1.25,2,2.75,3,3.25,4,4.25,5,5.25,9,9.25,Infinity,NaN]) {
      let lower=min,upper=max;if(Number.isFinite(lower)&&Number.isFinite(upper)&&lower>upper)[lower,upper]=[upper,lower];
      const expected=lower!==undefined&&value<lower?lower:upper!==undefined&&value>upper?upper:value;
      const frozen=Object.freeze({...limits});
      for(const actual of [curried(value),R.clamp(value,frozen),R.pipe(value,R.clamp(frozen))])equal(actual,expected);
      equal(limits,{...(min===undefined?{}:{min}),max});
    }
  }
} else throw Error('Unknown boundary task');
console.log('Length-relative/stateful finite boundary assertions passed',task,assertions);
