// Installed unchanged in the fixture; only discovers tests, never adds assertions.
import {readdir,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd();
const entries=(await Promise.all(['packages','apps'].map(p=>readdir(join(root,p),{recursive:true,withFileTypes:true})))).flat();
const paths=entries.filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name).slice(root.length+1));
const tests=paths.filter(p=>/^(?:packages|apps)\//.test(p)&&p.endsWith('.test.ts')&&!p.endsWith('/original.test.ts'));
console.log('Delivered test files:',JSON.stringify(tests));
if(tests.length===0){console.error('A new regression test file is required');process.exit(1);}
await mkdir(join(root,'.blame'),{recursive:true});let args;
if(process.argv[2]==='runtime'){
 await writeFile(join(root,'.blame/delivered.vitest.mjs'),'export default '+JSON.stringify({test:{include:tests,maxWorkers:1,fileParallelism:false,cache:false}})+';\n');
 args=['node_modules/vitest/vitest.mjs','run','--config','.blame/delivered.vitest.mjs'];
}else if(process.argv[2]==='types'){
 const config=JSON.parse(await readFile(join(root,'tsconfig.json'),'utf8'));
 const source=paths.filter(p=>/^(?:packages|apps)\//.test(p)&&p.endsWith('.ts')&&!p.endsWith('.test.ts'));
 await writeFile(join(root,'.blame/delivered.tsconfig.json'),JSON.stringify({compilerOptions:config.compilerOptions,files:[...source,...tests].map(p=>resolve(root,p))}));
 args=['node_modules/typescript/bin/tsc','--noEmit','-p','.blame/delivered.tsconfig.json'];
}else throw Error('Expected runtime or types');
const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',timeout:60000});process.exitCode=result.status??1;
