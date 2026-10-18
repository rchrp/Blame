// Researcher controls only; never copied into model workspaces.
import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
export async function positive(root,id){
 const base='packages/remeda/src/';const put=(p,s)=>writeFile(join(root,base+p),s);
 if(id==='suffix-counts'){
  for(const name of ['takeLast','dropLast']){const path=name+'.ts',old=await readFile(join(root,base+path),'utf8');
   const suffix=name==='takeLast'?'count===0?[]:array.slice(Math.max(0,array.length-count))':'array.slice(0,Math.max(0,array.length-count))';
   const text=old.replace(/: Array<T\[number\]> =>\s*\n[\s\S]*$/u,`: Array<T[number]> => {\n const count=Number.isNaN(n)||n<=0?0:n===Infinity?array.length:Math.floor(n);\n return ${suffix};\n};\n`);if(text===old)throw Error('Anchor '+name);await put(path,text);
  }
  await put('suffix.followup.test.ts',"import {test,expect} from 'vitest';import {takeLast,dropLast} from './index';test('floor counts',()=>{expect(takeLast([1,2,3],1.5)).toEqual([3]);expect(dropLast([1,2,3],1.5)).toEqual([1,2]);});\n");
 }else if(id==='reversed-clamp'){
  const old=await readFile(join(root,base+'clamp.ts'),'utf8'),start=old.indexOf('const clampImplementation');if(start<0)throw Error('Anchor clamp');
  await put('clamp.ts',old.slice(0,start)+`const clampImplementation=(value:number,{min,max}:Limits):number=>{\n let lower=min,upper=max;\n if(Number.isFinite(lower)&&Number.isFinite(upper)&&lower!>upper!){lower=max;upper=min;}\n return lower!==undefined&&value<lower?lower:upper!==undefined&&value>upper?upper:value;\n};\n`);
  await put('clamp.followup.test.ts',"import {test,expect} from 'vitest';import {clamp} from './index';test('reverse finite bounds',()=>{expect(clamp(2,Object.freeze({min:4,max:1}))).toBe(2);});\n");
 }else if(id==='slice-index'){
  const old=await readFile(join(root,base+'splitAt.ts'),'utf8');const text=old.replace(/const effectiveIndex = Math.max\([\s\S]*?\n  \);/u,'const effectiveIndex = index;');if(text===old)throw Error('Anchor split');await put('splitAt.ts',text);
  await put('split.followup.test.ts',"import {test,expect} from 'vitest';import {splitAt} from './index';test('negative fractional indexes',()=>{expect(splitAt([1,2,3],-.5)).toEqual([[],[1,2,3]]);});\n");
 }else throw Error('Unknown task');
}
export async function negative(root,id){
 const name=id==='suffix-counts'?'takeLast':id==='reversed-clamp'?'clamp':'splitAt',path=join(root,'packages/remeda/src',name+'.ts'),old=await readFile(path,'utf8');
 const text=id==='suffix-counts'?old.replace('Math.floor(n)','Math.ceil(n)'):id==='reversed-clamp'?old.replace('Number.isFinite(lower)&&Number.isFinite(upper)&&lower!>upper!','false'):old.replace('const effectiveIndex = index;','const effectiveIndex = index < 0 ? Math.max(0,array.length+index) : index;');
 if(text===old)throw Error('Mutant anchor');await writeFile(path,text);
}
