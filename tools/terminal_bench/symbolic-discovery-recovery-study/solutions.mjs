// Research controls only. Never import from prepare() or expose to model workers.
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function positive(root,id){
 const put=(path,source)=>writeFile(join(root,path),source);
 if(id==='credit-remainder'){
  await put('packages/credit/src/remainder.ts',`export function availableCredit(balance:number,reserved:number,limit:number):number {\n const normalizedLimit=limit>0?limit:0;\n const normalizedBalance=balance>0?balance:0;\n const normalizedReserved=reserved>0?reserved:0;\n const remainder=normalizedLimit-normalizedBalance-normalizedReserved;\n return remainder>0?remainder:0;\n}\n`);
  await put('packages/credit/src/allocation.ts',`import {availableCredit} from './remainder.ts';\nexport function approveDebit(balance:number,reserved:number,limit:number,requested:number):number {\n const demand=requested>0?requested:0;const available=availableCredit(balance,reserved,limit);return demand<available?demand:available;\n}\n`);
  await put('apps/policy/src/debit.ts',`import {availableCredit,approveDebit} from '../../../packages/credit/src/index.ts';\nexport function quoteDebit(balance:number,reserved:number,limit:number,requested:number) {\n const approved=approveDebit(balance,reserved,limit,requested);const available=availableCredit(balance,reserved,limit);const demand=requested>0?requested:0;return {approved,remaining:available-approved,denied:demand-approved};\n}\n`);
  await put('packages/credit/src/reservation.test.ts',`import {test,expect} from 'vitest';\nimport {quoteDebit} from '../../../apps/policy/src/debit.ts';\ntest('negative values normalize and reservation remains accounted',()=>{expect(quoteDebit(-3,5,10,20)).toEqual({approved:5,remaining:0,denied:15});});\n`);
 }else if(id==='inclusive-tier-allocation'){
  await put('packages/tiers/src/lower.ts',`export function lowerTierUnits(first:number,last:number,boundary:number):number {\n if(first>last)return 0;const lowerEnd=last<boundary?last:boundary;return lowerEnd>=first?lowerEnd-first+1:0;\n}\n`);
  await put('packages/tiers/src/upper.ts',`export function upperTierUnits(first:number,last:number,boundary:number):number {\n if(first>last)return 0;const upperStart=first>boundary?first:boundary+1;return last>=upperStart?last-upperStart+1:0;\n}\n`);
  await put('packages/tiers/src/cost.ts',`export function tierCost(lowerUnits:number,upperUnits:number,lowerRate:number,upperRate:number):number {\n const normalizedLowerRate=lowerRate>0?lowerRate:0;const normalizedUpperRate=upperRate>0?upperRate:0;return lowerUnits*normalizedLowerRate+upperUnits*normalizedUpperRate;\n}\n`);
  await put('apps/policy/src/tiers.ts',`import {lowerTierUnits,upperTierUnits,tierCost} from '../../../packages/tiers/src/index.ts';\nexport function quoteTierUsage(first:number,last:number,boundary:number,lowerRate:number,upperRate:number) {\n const lower=lowerTierUnits(first,last,boundary);const upper=upperTierUnits(first,last,boundary);return {lower,upper,totalCost:tierCost(lower,upper,lowerRate,upperRate)};\n}\n`);
  await put('packages/tiers/src/inclusive.test.ts',`import {test,expect} from 'vitest';\nimport {quoteTierUsage} from '../../../apps/policy/src/tiers.ts';\ntest('tier boundary belongs only to lower tier',()=>{expect(quoteTierUsage(-1,1,0,2,5)).toEqual({lower:2,upper:1,totalCost:9});});\n`);
 }else if(id==='signed-window-overlap'){
  await put('packages/windows/src/overlap.ts',`export function overlapLength(startA:number,endA:number,startB:number,endB:number):number {\n if(endA<=startA||endB<=startB)return 0;const start=startA>startB?startA:startB;const end=endA<endB?endA:endB;return end>start?end-start:0;\n}\n`);
  await put('packages/windows/src/qualifies.ts',`import {overlapLength} from './overlap.ts';\nexport function overlapsAtLeast(startA:number,endA:number,startB:number,endB:number,minimum:number):boolean {\n return minimum>0&&overlapLength(startA,endA,startB,endB)>=minimum;\n}\n`);
  await put('apps/policy/src/windows.ts',`import {overlapLength,overlapsAtLeast} from '../../../packages/windows/src/index.ts';\nexport function inspectShiftedWindow(startA:number,endA:number,startB:number,endB:number,offset:number,minimum:number) {\n const shiftedStart=startB+offset,shiftedEnd=endB+offset;return {overlap:overlapLength(startA,endA,shiftedStart,shiftedEnd),qualifies:overlapsAtLeast(startA,endA,shiftedStart,shiftedEnd,minimum)};\n}\n`);
  await put('packages/windows/src/signed.test.ts',`import {test,expect} from 'vitest';\nimport {inspectShiftedWindow} from '../../../apps/policy/src/windows.ts';\ntest('signed shifted overlap admits equality threshold',()=>{expect(inspectShiftedWindow(-5,1,-2,4,-2,5)).toEqual({overlap:5,qualifies:true});});\n`);
 }else throw Error('Unknown task '+id);
}
export async function negative(root,id){
 const path=id==='credit-remainder'?'apps/policy/src/debit.ts':id==='inclusive-tier-allocation'?'packages/tiers/src/lower.ts':'packages/windows/src/qualifies.ts';
 const before=await readFile(join(root,path),'utf8');
 const after=id==='credit-remainder'?before.replace('remaining:available-approved','remaining:limit-approved'):id==='inclusive-tier-allocation'?before.replace('lowerEnd-first+1','lowerEnd-first'):before.replace('>=minimum','>minimum');
 if(before===after)throw Error('Mutation anchor missing');await writeFile(join(root,path),after);
}
