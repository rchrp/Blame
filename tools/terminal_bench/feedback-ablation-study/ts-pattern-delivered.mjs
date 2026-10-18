import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
const root=process.cwd(),paths=(await readdir(join(root,'src'),{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name).slice(root.length+1));
const added=paths.filter(p=>p.endsWith('.test.ts'));if(!added.length){console.error('New src/*.test.ts required');process.exit(1);}
await mkdir(join(root,'.blame'),{recursive:true});console.log('Delivered test files:',JSON.stringify(added));let args;
if(process.argv[2]==='types'){const c=JSON.parse(await readFile(join(root,'.study/tsconfig.json'),'utf8'));await writeFile(join(root,'.blame/delivered.tsconfig.json'),JSON.stringify({compilerOptions:c.compilerOptions,files:paths.filter(p=>p.endsWith('.ts')).map(p=>resolve(root,p))}));args=['node_modules/typescript/bin/tsc','--noEmit','-p','.blame/delivered.tsconfig.json'];}
else {await writeFile(join(root,'.blame/delivered.vitest.mjs'),'export default '+JSON.stringify({test:{include:added,maxWorkers:1,fileParallelism:false,cache:false}})+';\n');args=['node_modules/vitest/vitest.mjs','run','--config','.blame/delivered.vitest.mjs'];}
const r=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',timeout:60000});process.exitCode=r.status??1;
