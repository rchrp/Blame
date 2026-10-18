import assert from 'node:assert/strict';import{test}from'node:test';import{mkdtemp,mkdir,writeFile,readFile,symlink,readlink,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{execFileSync}from'node:child_process';
import{prepareIsolatedNodeEnvironment,dependencyManifest,compareDependencyManifests}from'./isolated-node-environment.mjs';
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'blame-study-isolation-'));try{const baseline=join(root,'baseline');await mkdir(join(baseline,'compiler'),{recursive:true});await mkdir(join(baseline,'.bin'));await writeFile(join(baseline,'compiler/package.json'),'{"name":"fixture-compiler","version":"1.0.0"}');await writeFile(join(baseline,'compiler/cli.js'),'console.log("original")');await symlink('../compiler/cli.js',join(baseline,'.bin/compiler'));await run(root,baseline);}finally{await rm(root,{recursive:true,force:true});}}
test('trial package edits and generated caches cannot modify the baseline or another trial',()=>fixture(async(root,baseline)=>{
 const a=await prepareIsolatedNodeEnvironment({baselineModules:baseline,workspace:join(root,'a'),cacheRoot:join(root,'cache-a')});
 const b=await prepareIsolatedNodeEnvironment({baselineModules:baseline,workspace:join(root,'b'),cacheRoot:join(root,'cache-b')});
 await writeFile(join(root,'a/node_modules/compiler/cli.js'),'console.log("modified")');await mkdir(join(root,'a/node_modules/.vite'));await writeFile(join(root,'a/node_modules/.vite/result.json'),'{}');
 assert.equal(execFileSync(process.execPath,[join(root,'a/node_modules/.bin/compiler')],{encoding:'utf8'}).trim(),'modified');
 assert.equal(execFileSync(process.execPath,[join(root,'b/node_modules/.bin/compiler')],{encoding:'utf8'}).trim(),'original');
 assert.deepEqual(await dependencyManifest(baseline),a.manifest);assert.deepEqual(await dependencyManifest(join(root,'b/node_modules')),b.manifest);
 const diff=compareDependencyManifests(a.manifest,await dependencyManifest(join(root,'a/node_modules')));assert.equal(diff.pinnedDependenciesUnchanged,false);assert.deepEqual(diff.changed,['compiler/cli.js']);assert.deepEqual(diff.generated,['.vite/result.json']);
 assert.equal(await readlink(join(root,'a/node_modules/.bin/compiler')),'../compiler/cli.js');assert.notEqual(a.env.npm_config_cache,b.env.npm_config_cache);assert.equal(a.env.npm_config_offline,'true');
}));
test('new packages and removed pinned files are deviations while caches remain explicit',()=>fixture(async(root,baseline)=>{
 const before=await dependencyManifest(baseline),after={...before};delete after['compiler/cli.js'];after['surprise/package.json']={kind:'file',sha256:'new'};after['.vitest-cache/result']={kind:'file',sha256:'cache'};
 assert.deepEqual(compareDependencyManifests(before,after),{pinnedDependenciesUnchanged:false,changed:[],missing:['compiler/cli.js'],added:['surprise/package.json'],generated:['.vitest-cache/result'],generatedModified:[]});
}));

test('existing Vitest result data can change without hiding pinned package changes',()=>fixture(async(root,baseline)=>{
 const path='.vite/vitest/'+ 'a'.repeat(40)+'/results.json';
 await mkdir(join(baseline,path,'..'),{recursive:true});await writeFile(join(baseline,path),'{"version":"3.2.4","results":[]}');
 const before=await dependencyManifest(baseline);await writeFile(join(baseline,path),'{"version":"3.2.4","results":[["case.test.ts",{"failed":false}]]}');
 const cacheOnly=compareDependencyManifests(before,await dependencyManifest(baseline));
 assert.equal(cacheOnly.pinnedDependenciesUnchanged,true);assert.deepEqual(cacheOnly.generatedModified,[path]);assert.deepEqual(cacheOnly.changed,[]);
 await writeFile(join(baseline,'compiler/cli.js'),'console.log("changed package")');
 const packageEdit=compareDependencyManifests(before,await dependencyManifest(baseline));assert.equal(packageEdit.pinnedDependenciesUnchanged,false);assert.deepEqual(packageEdit.changed,['compiler/cli.js']);assert.deepEqual(packageEdit.generatedModified,[path]);
}));
test('executable cache files and similarly named paths remain pinned',()=>{
 for(const path of ['.vite/vitest/'+ 'a'.repeat(40)+'/runner.js','.vite/vitest/project/results.json','.vite/vitest/'+ 'a'.repeat(40)+'/result.json']){
  const result=compareDependencyManifests({[path]:{kind:'file',sha256:'before'}},{[path]:{kind:'file',sha256:'after'}});
  assert.equal(result.pinnedDependenciesUnchanged,false);assert.deepEqual(result.changed,[path]);assert.deepEqual(result.generatedModified,[]);
 }
});
test('Vitest result data cannot change into or out of a symbolic link',()=>{
 const path='.vite/vitest/'+ 'a'.repeat(40)+'/results.json',file={kind:'file',sha256:'data'},symlink={kind:'symlink',target:'../../compiler/cli.js'};
 for(const [before,after]of [[file,symlink],[symlink,file]])assert.equal(compareDependencyManifests({[path]:before},{[path]:after}).pinnedDependenciesUnchanged,false);
});
test('external symlinks are rejected instead of retaining shared package bytes',()=>fixture(async(root,baseline)=>{
 await symlink('../../outside.js',join(baseline,'compiler/external.js'));
 await assert.rejects(()=>prepareIsolatedNodeEnvironment({baselineModules:baseline,workspace:join(root,'trial'),cacheRoot:join(root,'cache')}),/External dependency link/);
}));
test('existing dependencies are preserved and cannot be silently replaced',()=>fixture(async(root,baseline)=>{
 const workspace=join(root,'trial');await mkdir(join(workspace,'node_modules'),{recursive:true});await writeFile(join(workspace,'node_modules/owned'),'keep');
 await assert.rejects(()=>prepareIsolatedNodeEnvironment({baselineModules:baseline,workspace,cacheRoot:join(root,'cache')}),/Refusing to replace/);assert.equal(await readFile(join(workspace,'node_modules/owned'),'utf8'),'keep');
}));

test('warm caches cannot leak tool installs into the next trial',()=>fixture(async(root,baseline)=>{
 const cache=join(root,'cache');await mkdir(cache);await writeFile(join(cache,'previous-tool'),'cached');
 await assert.rejects(()=>prepareIsolatedNodeEnvironment({baselineModules:baseline,workspace:join(root,'next'),cacheRoot:cache}),/Refusing to reuse/);
 assert.equal(await readFile(join(cache,'previous-tool'),'utf8'),'cached');
}));

test('ancestor dependencies cannot supply undeclared tools to a future trial',()=>fixture(async(root,baseline)=>{
 await mkdir(join(root,'node_modules/unregistered'),{recursive:true});
 await writeFile(join(root,'node_modules/unregistered/package.json'),'{"name":"unregistered","version":"1.0.0"}');
 await assert.rejects(()=>prepareIsolatedNodeEnvironment({baselineModules:baseline,workspace:join(root,'trial'),cacheRoot:join(root,'cache')}),/Ancestor dependencies are reachable/);
}));

test('offline trial environment refuses an undeclared tool without contacting a registry',()=>fixture(async(root,baseline)=>{
 const {createServer}=await import('node:http');const {spawn}=await import('node:child_process');const requests=[];const server=createServer((_req,res)=>{requests.push(_req.url);res.writeHead(404);res.end('unregistered');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const workspace=join(root,'trial');const isolated=await prepareIsolatedNodeEnvironment({baselineModules:baseline,workspace,cacheRoot:join(root,'cache')});
 const result=await new Promise((resolve,reject)=>{const child=spawn('npm',['exec','--yes','--package=blame-study-undeclared-tool@1.0.0','--','blame-study-undeclared-tool'],{cwd:workspace,env:{...process.env,...isolated.env,npm_config_registry:`http://127.0.0.1:${server.address().port}`},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);child.once('error',reject);child.once('close',code=>resolve({code,output}));});
 assert.notEqual(result.code,0);assert.match(result.output,/ENOTCACHED/);assert.deepEqual(requests,[]);assert.deepEqual(await dependencyManifest(baseline),isolated.manifest);
 }finally{await new Promise(resolve=>server.close(resolve));}
}));
