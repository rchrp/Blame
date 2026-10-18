// Post-hoc, uniform and conditional. Never rewrites the registered primary scores.
import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import{resolve,join}from'node:path';import{gunzipSync}from'node:zlib';import{atomicJson,digest}from'../durable-campaign.mjs';
const repo=resolve(import.meta.dirname,'../../..'),study=join(repo,'docs/experiments/light-harness-navigation-large-f53-2026-10-18');
const json=async p=>JSON.parse(await readFile(join(study,p)));const results=await json('results.json'),summary=await json('summary.json'),review=await json('source-review.json'),rows=[];
assert.equal(results.rows.length,18);assert.equal((await json('verification.json')).trials,18);
for(const r of results.rows){
 const bytes=await readFile(join(study,'traces',r.name+'.json.gz'));assert.equal(digest(bytes),r.traceSha256);const a=JSON.parse(gunzipSync(bytes));
 const read=name=>{const f=a.files[name];assert.ok(f);const b=Buffer.from(f.base64,'base64');assert.equal(digest(b),f.sha256);return JSON.parse(b);};
 const grade=read('score.json'),environment=read('environment.json'),d=review.decisions.find(d=>d.name===r.name);assert.deepEqual(d.hashes,r.hashes);
 const i=grade.dependencyIntegrity;
 const cacheOnly=i.pinnedDependenciesUnchanged===false&&i.changed.length>0&&i.missing.length===0&&i.added.length===0&&i.changed.every(p=>/^\.vite\/vitest\/[a-f0-9]{40}\/results\.json$/.test(p)&&environment.manifest[p]?.kind==='file');
 const other=r.independentFunctionalSuccess&&d.sourceBehaviorPassed&&d.addedTestsPassed&&d.finalSourceChecksPassed&&d.noSolutionRetrieval&&d.fullRequestPassed&&d.symbolicClaimsAccurate;
 const conditionalCompletion=other&&(d.dependencyIntegrityPassed||cacheOnly);
 // In this dataset the separately verified functional comparison has exactly
 // this cohort. If another criterion differs, do not silently reuse its totals.
 assert.equal(conditionalCompletion,r.independentFunctionalSuccess);
 rows.push({name:r.name,arm:r.arm,primaryStrict:r.auditedCompletion,independentFunctional:r.independentFunctionalSuccess,cacheOnlyDeviation:cacheOnly,changed:i.changed,conditionalCompletion,afterManifestRetained:!!a.files['dependency-after-manifest.json']});
}
const arms=Object.fromEntries(['reference','candidate','cline'].map(arm=>[arm,{assigned:6,primaryStrict:rows.filter(r=>r.arm===arm&&r.primaryStrict).length,independentFunctional:rows.filter(r=>r.arm===arm&&r.independentFunctional).length,conditional:rows.filter(r=>r.arm===arm&&r.conditionalCompletion).length,cacheOnlyDeviations:rows.filter(r=>r.arm===arm&&r.cacheOnlyDeviation).length}]));
const bindings={};for(const p of ['results.json','summary.json','source-review.json','cache-sensitivity-protocol.json'])bindings[p]=digest(await readFile(join(study,p)));
await atomicJson(join(study,'cache-sensitivity.json'),{modelCalls:0,postHoc:true,primaryUnchanged:true,arms,rows,comparisons:summary.functionalComparisons,bindings,method:'Apply registered cache-only condition uniformly to every assigned trial and retain all other reviewed criteria. The resulting cohort exactly matches the independently verified functional-comparison cohort; its arithmetic is reused only after per-trial equality assertions.',limitation:'Old cache contents and post-run dependency kinds/hashes were not archived. This is a conditional path/command-based sensitivity, not attestation of the modified cache payload, and does not replace the primary strict scores. New local controls verify the future classifier; they do not recover missing old bytes.'},{exclusive:true});
console.log(JSON.stringify(arms));
