// Hidden finite behavioral/public-type oracle. Never copied into model workspaces.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const root=process.argv[2],task=process.argv[3];
const load=p=>import(pathToFileURL(join(root,p)).href);
let assertions=0,typeSource;
const equal=(actual,wanted,context)=>{assert.deepEqual(actual,wanted,JSON.stringify(context));assertions++;};
if(task==='credit-remainder'){
 const {availableCredit,approveDebit}=await load('packages/credit/src/index.ts');
 const {quoteDebit}=await load('apps/policy/src/debit.ts');
 const grid=[-11,-1,0,1,3,9,21,1000000];
 for(const balance of grid)for(const reserved of grid)for(const limit of grid){
  let budget=limit>0?limit:0;
  for(const debit of [balance,reserved])budget=debit<=0?budget:debit>=budget?0:budget-debit;
  equal(availableCredit(balance,reserved,limit),budget,{balance,reserved,limit});
  for(const requested of grid){const demand=requested>0?requested:0;const approved=demand>budget?budget:demand;
   equal(approveDebit(balance,reserved,limit,requested),approved,{balance,reserved,limit,requested});
   equal(quoteDebit(balance,reserved,limit,requested),{approved,remaining:budget-approved,denied:demand-approved},{balance,reserved,limit,requested});
  }
 }
 typeSource=`import {availableCredit,approveDebit} from '../packages/credit/src/index.ts';\nimport {quoteDebit} from '../apps/policy/src/debit.ts';\nconst available:(balance:number,reserved:number,limit:number)=>number=availableCredit;\nconst approve:(balance:number,reserved:number,limit:number,requested:number)=>number=approveDebit;\nconst quote:{approved:number;remaining:number;denied:number}=quoteDebit(1,2,3,4);void available;void approve;void quote;\n`;
}else if(task==='inclusive-tier-allocation'){
 const {lowerTierUnits,upperTierUnits,tierCost}=await load('packages/tiers/src/index.ts');
 const {quoteTierUsage}=await load('apps/policy/src/tiers.ts');
 const grid=[-7,-2,-1,0,1,4,9];
 for(const first of grid)for(const last of grid)for(const boundary of grid){
  let lower=0,upper=0;for(let unit=first;unit<=last;unit++){if(unit<=boundary)lower++;else upper++;}
  equal(lowerTierUnits(first,last,boundary),lower,{first,last,boundary});equal(upperTierUnits(first,last,boundary),upper,{first,last,boundary});
  for(const [lowerRate,upperRate]of [[0,0],[1,2],[3,1],[-1,2],[2,-1],[-4,-2]]){
   let totalCost=0;for(let unit=first;unit<=last;unit++)totalCost+=Math.max(unit<=boundary?lowerRate:upperRate,0);
   equal(tierCost(lower,upper,lowerRate,upperRate),totalCost,{lower,upper,lowerRate,upperRate});
   equal(quoteTierUsage(first,last,boundary,lowerRate,upperRate),{lower,upper,totalCost},{first,last,boundary,lowerRate,upperRate});
  }
 }
 equal(quoteTierUsage(-1000000,1000000,0,1000000,1000000),{lower:1000001,upper:1000000,totalCost:2000001000000},'large safe integer endpoints');
 typeSource=`import {lowerTierUnits,upperTierUnits,tierCost} from '../packages/tiers/src/index.ts';\nimport {quoteTierUsage} from '../apps/policy/src/tiers.ts';\nconst lower:(first:number,last:number,boundary:number)=>number=lowerTierUnits;\nconst upper:typeof lower=upperTierUnits;\nconst cost:(lowerUnits:number,upperUnits:number,lowerRate:number,upperRate:number)=>number=tierCost;\nconst quote:{lower:number;upper:number;totalCost:number}=quoteTierUsage(1,2,3,4,5);void lower;void upper;void cost;void quote;\n`;
}else if(task==='signed-window-overlap'){
 const {overlapLength,overlapsAtLeast}=await load('packages/windows/src/index.ts');
 const {inspectShiftedWindow}=await load('apps/policy/src/windows.ts');
 const grid=[-7,-2,0,1,4,9], minGrid=[-1,0,1,2,5,11];
 const cells=(start,end)=>{const out=new Set();for(let cell=start;cell<end;cell++)out.add(cell);return out;};
 for(const startA of grid)for(const endA of grid)for(const startB of grid)for(const endB of grid){
  const a=cells(startA,endA),b=cells(startB,endB);const overlap=[...a].filter(cell=>b.has(cell)).length;
  equal(overlapLength(startA,endA,startB,endB),overlap,{startA,endA,startB,endB});
  for(const minimum of minGrid){
   equal(overlapsAtLeast(startA,endA,startB,endB,minimum),minimum>0&&overlap>=minimum,{startA,endA,startB,endB,minimum});
   for(const offset of [-5,0,4]){const shifted=cells(startB+offset,endB+offset);const expected=[...a].filter(cell=>shifted.has(cell)).length;
    equal(inspectShiftedWindow(startA,endA,startB,endB,offset,minimum),{overlap:expected,qualifies:minimum>0&&expected>=minimum},{startA,endA,startB,endB,offset,minimum});
   }
  }
 }
 equal(overlapLength(-1000000,1000000,-999999,999999),1999998,'large safe integer endpoints');
 equal(inspectShiftedWindow(-1000000,1000000,-1000000,1000000,1000000,1000000),{overlap:1000000,qualifies:true},'large safe shifted endpoints');
 typeSource=`import {overlapLength,overlapsAtLeast} from '../packages/windows/src/index.ts';\nimport {inspectShiftedWindow} from '../apps/policy/src/windows.ts';\nconst length:(startA:number,endA:number,startB:number,endB:number)=>number=overlapLength;\nconst qualified:(startA:number,endA:number,startB:number,endB:number,minimum:number)=>boolean=overlapsAtLeast;\nconst quote:{overlap:number;qualifies:boolean}=inspectShiftedWindow(1,2,3,4,5,6);void length;void qualified;void quote;\n`;
}else throw Error('Unknown task '+task);
await mkdir(join(root,'.blame'),{recursive:true});await writeFile(join(root,'.blame/hidden-contract.ts'),typeSource);
const compiler=JSON.parse(await readFile(join(root,'tsconfig.json'),'utf8'));
await writeFile(join(root,'.blame/hidden-contract.json'),JSON.stringify({compilerOptions:compiler.compilerOptions,files:['hidden-contract.ts']}));
const types=spawnSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','-p',join(root,'.blame/hidden-contract.json')],{cwd:root,encoding:'utf8',timeout:60000});
assert.equal(types.status,0,types.stdout+types.stderr);
console.log('Hidden behavioral and public type contracts passed:',task,'assertions:',assertions);
