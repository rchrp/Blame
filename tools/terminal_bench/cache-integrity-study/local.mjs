// Actual pinned runner control, outside all model workers.
import assert from 'node:assert/strict';import{mkdtemp,mkdir,readFile,writeFile,rm}from'node:fs/promises';import{join,resolve}from'node:path';import{spawnSync}from'node:child_process';import{prepareIsolatedNodeEnvironment,dependencyManifest,compareDependencyManifests}from'../isolated-node-environment.mjs';import{atomicJson,digest}from'../durable-campaign.mjs';
const repo=resolve(import.meta.dirname,'../../..'),study=join(repo,'docs/experiments/light-harness-cache-integrity-f56-2026-10-18');
const root=await mkdtemp('/workspace/blame-study-runs/cache-integrity-f56-'),workspace=join(root,'workspace');await mkdir(workspace);
const baseline=join(repo,'.blame/research/validation-scope-f44/dependencies/node_modules');
const isolated=await prepareIsolatedNodeEnvironment({baselineModules:baseline,workspace,cacheRoot:join(root,'npm-cache')});
const cachePath='.vite/vitest/'+ 'da39a3ee5e6b4b0d3255bfef95601890afd80709'+'/results.json',cache=join(workspace,'node_modules',cachePath);
await mkdir(join(cache,'..'),{recursive:true});await writeFile(cache,JSON.stringify({version:'3.2.4',results:[]}));
const source="import {test,expect} from 'vitest';test('actual runner',()=>expect(2+2).toBe(4));\n";await writeFile(join(workspace,'package.json'),'{"type":"module"}');await writeFile(join(workspace,'case.test.ts'),source);
const before=await dependencyManifest(join(workspace,'node_modules'));
const args=['node_modules/vitest/vitest.mjs','run','case.test.ts','--maxWorkers=1','--fileParallelism=false'];
const run=spawnSync(process.execPath,args,{cwd:workspace,env:{...process.env,...isolated.env},encoding:'utf8',timeout:30000});assert.equal(run.status,0,run.stderr);
const after=await dependencyManifest(join(workspace,'node_modules')),cacheOnly=compareDependencyManifests(before,after),cacheContents=JSON.parse(await readFile(cache));
assert.equal(cacheOnly.pinnedDependenciesUnchanged,true);assert.deepEqual(cacheOnly.generatedModified,[cachePath]);assert.equal(cacheContents.version,'3.2.4');assert.ok(cacheContents.results.length>0);
const packagePath=join(workspace,'node_modules/vitest/package.json'),pkg=JSON.parse(await readFile(packagePath));pkg.version='0.0.0-local-negative-control';await writeFile(packagePath,JSON.stringify(pkg));
const packageMutation=compareDependencyManifests(before,await dependencyManifest(join(workspace,'node_modules')));assert.equal(packageMutation.pinnedDependenciesUnchanged,false);assert.ok(packageMutation.changed.includes('vitest/package.json'));
assert.deepEqual(await dependencyManifest(baseline),isolated.manifest);
await atomicJson(join(study,'local-controls.json'),{modelCalls:0,source,sourceSha256:digest(source),node:process.version,argv:args,runner:{exitCode:run.status,stdout:run.stdout,stderr:run.stderr},beforeManifestSha256:digest(JSON.stringify(before)),afterManifestSha256:digest(JSON.stringify(after)),cacheOnly,cacheContents,packageMutation,baselineUnchanged:true,boundary:'Only known non-executable Vitest results-file updates are classified as generated modifications. This is not full environment attestation or task/source acceptance.'},{exclusive:true});
await rm(root,{recursive:true});console.log('Real Vitest cache update admitted as generated data; package mutation rejected; baseline unchanged.');
