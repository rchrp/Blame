import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {repo,study,save,sha} from './setup.mjs';
const argv=['--test','--test-reporter=tap','tools/terminal_bench/request-timing.test.mjs'];
const result=spawnSync(process.execPath,argv,{cwd:repo,encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stdout+result.stderr);
const count=name=>Number(new RegExp('^# '+name+' (\\d+)$','m').exec(result.stdout)?.[1]);assert.equal(count('tests'),12);assert.equal(count('pass'),12);assert.equal(count('fail'),0);
const boundary=JSON.parse(await readFile(join(study,'feedback-boundary-controls.json'),'utf8'));assert.equal(boundary.complete,true);assert.equal(boundary.timingPreloadPreservesRequest,true);
const paths=['tools/terminal_bench/request-timing.mjs','tools/terminal_bench/request-timing-preload.mjs','tools/terminal_bench/request-timing.test.mjs','tools/terminal_bench/latency-intervals.mjs','tools/terminal_bench/latency-profile.mjs'];
await save(join(study,'timing-controls.json'),{complete:true,modelRequests:0,command:process.execPath,argv,exitCode:result.status,tests:count('tests'),passed:count('pass'),stdout:result.stdout,stderr:result.stderr,
 actualPreloadRequestHashJoin:true,demandDrivenNoEagerRead:true,abortCancellationErrorIdentityPreserved:true,utf8AndJsonPreserved:true,headerAndCloneMetadataPreserved:true,
 pendingAndRepeatedAttemptsDistinct:true,overlappingIntervalsNotDoubleCounted:true,sourceHashes:Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(join(repo,p)))]))),
 limits:'Observer timestamps include observer and client processing overhead. Consumer-driven stream read completion is not a pure server/network span. No request or response body, headers or credential/error text is retained.'});
console.log('12 timing controls and actual common-preload hash join passed; zero network/model calls');
