// Outside measured workers: remove only grader-added cache files and restore
// the exact dependency-image digest already frozen before model dispatch.
import assert from 'node:assert/strict';import {readFile,mkdir,copyFile,rm} from 'node:fs/promises';import {join} from 'node:path';
import {work,study} from './inputs.mjs';import {dependencyManifest} from '../isolated-node-environment.mjs';import {atomicJson,digest} from '../durable-campaign.mjs';
const p=JSON.parse(await readFile(join(study,'model-protocol.json'))),image=p.dependencies['fetching-filters'];
const original=JSON.parse(await readFile(join(work,'campaign/1-fetching-filters-compact/environment.json'))).manifest;
for(const name of ['query-core','react-query','query-test-utils'])delete original['@tanstack/'+name];
assert.equal(digest(JSON.stringify(original)),image.manifestSha256,'Original per-worker image must match the pre-dispatch binding');
const now=await dependencyManifest(image.modules),changed=Object.keys(original).filter(k=>JSON.stringify(original[k])!==JSON.stringify(now[k]));assert.deepEqual(changed,[],'Never guess at changed original package/cache bytes');
const added=Object.keys(now).filter(k=>!(k in original));assert.ok(added.every(k=>/^\.vitest-cache\/[a-f0-9]{40}$/u.test(k)&&now[k].kind==='file'),'Only added regular Vitest transform-cache files may be removed');
const stamp=new Date().toISOString().replaceAll(':','-'),backup=join(work,'grader-cache-backups',stamp);
for(const path of added){await mkdir(join(backup,path,'..'),{recursive:true});await copyFile(join(image.modules,path),join(backup,path));await rm(join(image.modules,path));}
const restored=digest(JSON.stringify(await dependencyManifest(image.modules)));assert.equal(restored,image.manifestSha256);
await atomicJson(join(study,'environment-maintenance',stamp+'.json'),{atUTC:new Date().toISOString(),reason:'Independent Vitest 5 grading added executable transform-cache entries through the baseline node_modules symlink; the next dispatch binding failed closed before any new model invocation.',originalManifestSha256:image.manifestSha256,restoredManifestSha256:restored,originalCacheFiles:Object.keys(original).filter(k=>/^(?:\.vitest-cache|\.vite|\.cache)\//u.test(k)).length,changedOriginalFiles:changed,removedAddedFiles:added.map(path=>({path,...now[path]})),modelRetried:false,gradingCriteriaChanged:false,boundary:'Only exact original dependency bytes enter each new worker. Added cache contents are retained privately for forensics, not supplied to later workers. Model invocations and original negative outcomes are not repeated.'},{exclusive:true});
console.log('Restored frozen dependency image; removed '+added.length+' grader-added cache files.');
