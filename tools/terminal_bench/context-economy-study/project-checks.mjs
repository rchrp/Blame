// Frozen adapter: relevant original regressions and independently compiled new tests.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
const task=JSON.parse(await readFile('.study/task.json'));
const original=new Set(task.originalTests);
const all=execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const newTests=[...new Set(all)].filter(p=>task.scope.some(s=>p.startsWith(s+'/'))&&p.includes('/__tests__/')&&/\.test(?:-d)?\.tsx?$/u.test(p)&&!original.has(p));
const runtime=newTests.filter(p=>!/\.test-d\.tsx?$/u.test(p));
const action=process.argv[2];let args;
await mkdir('.study/reports',{recursive:true});
if(action==='regression')args=['node_modules/vitest/vitest.mjs','run','--configLoader','native','--config','.study/vitest.config.mjs','packages/query-core/src/__tests__',...(task.id==='fetching-filters'?['packages/react-query/src/__tests__/useIsFetching.test.tsx']:[])];
else if(action==='delivered'){
 if(!runtime.length){process.stderr.write('No new executable regression test was delivered.\n');process.exit(1);}
 args=['node_modules/vitest/vitest.mjs','run','--configLoader','native','--config','.study/vitest.config.mjs',...runtime];
}else if(action==='delivered-types'){
 if(!newTests.length){process.stderr.write('No new test/type regression was delivered.\n');process.exit(1);}
 const base=JSON.parse(await readFile('.study/source-tsconfig.json'));delete base.include;delete base.exclude;
 const typeInputs=[...newTests];
 // Preserve the original React package's ambient matcher declarations.
 if(newTests.some(p=>p.startsWith('packages/react-query/src/')))typeInputs.push('packages/react-query/test-setup.ts');
 await writeFile('.study/reports/delivered-tsconfig.json',JSON.stringify({...base,compilerOptions:{...base.compilerOptions,paths:Object.fromEntries(Object.entries(base.compilerOptions.paths).map(([k,v])=>[k,v.map(p=>'../'+p)]))},files:typeInputs.map(p=>'../../'+p)}));
 args=['node_modules/typescript/bin/tsc','--noEmit','-p','.study/reports/delivered-tsconfig.json'];
}else throw Error('Unknown check');
const r=spawnSync(process.execPath,args,{stdio:'inherit',env:process.env});process.exit(r.status??1);
