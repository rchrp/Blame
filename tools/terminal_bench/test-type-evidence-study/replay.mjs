// Local diagnostic controls only; no model calls or task-success claims.
// node [--import <tsx-loader>] replay.mjs <check-observation-module> <dependency-root> <new-output.json>
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {access,cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const modulePath=resolve(process.argv[2]),dependencies=resolve(process.argv[3]),output=resolve(process.argv[4]);
await access(output).then(()=>{throw Error('Refusing to overwrite evidence');},error=>{if(error.code!=='ENOENT')throw error;});
const repo=resolve(import.meta.dirname,'../../..'),sha=value=>createHash('sha256').update(value).digest('hex');
const sources={};for(const name of ['check-observation','test-type-evidence','light-validation-report']){
 const path=join(dirname(modulePath),name+modulePath.slice(modulePath.lastIndexOf('.')));sources[path]=sha(await readFile(path));
}
const {observeCheck}=await import(pathToFileURL(modulePath));
const root=await mkdtemp(join(tmpdir(),'blame-type-evidence-'));
try{
 await cp(join(dependencies,'node_modules'),join(root,'node_modules'),{recursive:true});
 await mkdir(join(root,'src'));
 const source="import{test,expect}from'vitest';const value:number='wrong type';test('runtime only',()=>expect(value).toBe('wrong type'));\n";
 const config="export default {test:{typecheck:{enabled:true,include:['src/delivered.test.ts'],ignoreSourceErrors:true}}};\n";
 await writeFile(join(root,'package.json'),JSON.stringify({type:'module'}));
 await writeFile(join(root,'src/delivered.test.ts'),source);
 await writeFile(join(root,'custom.config.mjs'),config);
 await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,noEmit:true,target:'ES2022',module:'ESNext',moduleResolution:'Bundler',skipLibCheck:true},include:['src/delivered.test.ts']}));
 const versions={};for(const name of ['vitest','typescript'])versions[name]=JSON.parse(await readFile(join(root,'node_modules',name,'package.json'))).version;
 assert.deepEqual(versions,{vitest:'3.2.4',typescript:'5.9.3'});
 const run=args=>{const start=Date.now(),result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:30000});
  assert.equal(result.error,undefined);return{args,exitCode:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr,durationMs:Date.now()-start};};
 const observe=result=>observeCheck('node '+result.args.join(' '),{all:result.stdout+result.stderr,exitCode:result.exitCode??undefined,failed:result.exitCode!==0},'.',false);
 const normal=run(['node_modules/vitest/vitest.mjs','run','src/delivered.test.ts','--maxWorkers=1','--no-file-parallelism','--typecheck.enabled','--typecheck.ignoreSourceErrors']);
 assert.equal(normal.exitCode,0);assert.match(normal.stdout,/Type Errors\s+no errors/);
 const compiler=run(['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json']);
 assert.equal(compiler.exitCode,2);assert.match(compiler.stdout,/TS2322/);
 const explicitSelection=run(['node_modules/vitest/vitest.mjs','run','src/delivered.test.ts','--maxWorkers=1','--no-file-parallelism','--config','custom.config.mjs']);
 assert.equal(explicitSelection.exitCode,1);assert.match(explicitSelection.stdout+explicitSelection.stderr,/TypeCheckError: Type 'string' is not assignable to type 'number'/);
 assert.match(explicitSelection.stdout,/Type Errors\s+no errors/);
 const controls={normal:{...normal,check:observe(normal)},compiler,explicitSelection:{...explicitSelection,check:observe(explicitSelection)}};
 assert.equal(controls.normal.check.typechecking.reportedErrors,'none');
 assert.equal(controls.normal.check.typechecking.requested,true);
 assert.equal(controls.normal.check.typechecking.testFileSelection,'unknown');
 assert.equal(controls.explicitSelection.check.typechecking.requested,null);
 assert.equal(controls.explicitSelection.check.typechecking.reportedErrors,'unknown');
 assert.equal(controls.explicitSelection.check.typechecking.testFileSelection,'unknown');
 assert.equal(controls.explicitSelection.check.outcome,'failed');
 for(const[path,hash]of Object.entries(sources))assert.equal(sha(await readFile(path)),hash,'Evidence module changed during replay');
 const evidence={modelRequests:0,method:'Fresh local fixture; copied pinned dependencies. Compare default Vitest runtime selection, direct tsc, and custom Vitest typecheck selection. Observed text is diagnostic only and never admits file selection or source verification.',researcherCodeCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),modulePath,sources,versions,inputs:{source,sourceSha256:sha(source),config,configSha256:sha(config)},controls};
 await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({output,modelRequests:0,runtimePassedDespiteTypeError:true,customSelectionFailed:true}));
}finally{await rm(root,{recursive:true,force:true});}
