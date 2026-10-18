// Optional broad check: original related tests and exact newly delivered tests.
// This does not add assertions, retrieve solutions or repair the submitted source.
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),task=JSON.parse(await readFile(new URL('./task.json',import.meta.url),'utf8'));
const paths=(await readdir(join(root,task.sourceRoot),{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name).slice(root.length+1).replaceAll('\\','/'));
const allTests=paths.filter(p=>/\.(?:test|spec)(?:-d)?\.ts$/.test(p)),original=new Set(task.originalTests);
const added=allTests.filter(p=>!original.has(p));
if(!added.length){console.error("A new test file is required");process.exit(1);}
const selected=task.selected.flatMap(p=>['.test.ts','.test-d.ts'].map(s=>task.sourceRoot+'/'+p+s)).filter(p=>paths.includes(p));
const tests=[...new Set([...selected,...added])];
await mkdir(join(root,'.blame'),{recursive:true});
console.log('Delivered test files:',JSON.stringify(added));
let args;
if(process.argv[2]==='types'){
 const config=JSON.parse(await readFile(new URL('./tsconfig.json',import.meta.url),'utf8'));
 const production=paths.filter(p=>p.endsWith('.ts')&&!/\.(?:test|spec)(?:-d)?\.ts$/.test(p)&&!p.endsWith('.bench.ts')&&!p.includes('/vitest/'));
 await writeFile(join(root,'.blame/delivered.tsconfig.json'),JSON.stringify({compilerOptions:config.compilerOptions,files:[...production,...tests,'.study/types.ts'].map(p=>resolve(root,p))}));
 args=['node_modules/typescript/bin/tsc','--noEmit','-p','.blame/delivered.tsconfig.json'];
}else if(process.argv[2]==='runtime'){
 await writeFile(join(root,'.blame/delivered.vitest.mjs'),'export default '+JSON.stringify({test:{include:tests.filter(p=>p.endsWith('.test.ts')||p.endsWith('.spec.ts')),maxWorkers:1,fileParallelism:false,cache:false}})+';\n');
 args=['node_modules/vitest/vitest.mjs','run','--config','.blame/delivered.vitest.mjs'];
}else throw Error('Expected types or runtime');
const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',timeout:60000});
process.exitCode=result.status??1;
