import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),task=JSON.parse(await readFile(new URL('./task.json',import.meta.url),'utf8'));
const paths=(await readdir(join(root,'src'),{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name).slice(root.length+1).replaceAll('\\','/'));
const added=paths.filter(p=>/\.(?:test|spec)\.ts$/.test(p)&&!task.originalTests.includes(p));
if(!added.length){console.error('A new test file is required');process.exit(1);}
await mkdir(join(root,'.blame'),{recursive:true});console.log('Delivered test files:',JSON.stringify(added));let argv;
if(process.argv[2]==='types'){
 const config=JSON.parse(await readFile(join(root,'.study/tsconfig.json'),'utf8'));config.compilerOptions.baseUrl=resolve(root);config.files=paths.filter(p=>p.endsWith('.ts')&&!/\.(?:test|spec)\.ts$/.test(p)).concat(added).map(p=>resolve(root,p));delete config.include;delete config.exclude;
 await writeFile(join(root,'.blame/delivered.tsconfig.json'),JSON.stringify(config));argv=['node_modules/typescript/bin/tsc','--noEmit','-p','.blame/delivered.tsconfig.json'];
}else if(process.argv[2]==='runtime'){
 const {default:config}=await import(new URL('./vitest.config.mjs',import.meta.url));config.test.include=[...config.test.include,...added];
 await writeFile(join(root,'.blame/delivered.vitest.mjs'),'export default '+JSON.stringify(config)+';\n');argv=['node_modules/vitest/vitest.mjs','run','--config','.blame/delivered.vitest.mjs'];
}else throw Error('Expected runtime or types');
const r=spawnSync(process.execPath,argv,{cwd:root,stdio:'inherit',timeout:60000});process.exitCode=r.status??1;
