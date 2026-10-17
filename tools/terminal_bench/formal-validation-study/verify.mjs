// Portable artifact consistency verification; reproducing solver/fixtures remains
// a separate command. Never edits or repairs discrepancies in the evidence.
import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const study=resolve(process.argv[2]??join(repo,'docs/experiments/light-harness-formal-validation-f46-2026-10-18'));
const output=process.argv[3]?resolve(process.argv[3]):null;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes={};const json={};for(const name of ['protocol.json','model.json','runtime.json']){bytes[name]=await readFile(join(study,name));json[name]=JSON.parse(bytes[name]);}
const protocol=json['protocol.json'],model=json['model.json'],runtime=json['runtime.json'];
for(const [path,hash]of Object.entries(protocol.artifacts))assert.equal(sha(await readFile(join(repo,path))),hash,`Frozen binding changed: ${path}`);
for(const [path,hash]of Object.entries(runtime.studyScripts))assert.equal(sha(await readFile(join(repo,'tools/terminal_bench/formal-validation-study',path))),hash);
assert.equal(model.z3Package,'z3-solver==4.15.4.0');assert.equal(model.truthTableEquivalence,'unsat');assert.equal(model.cases.length,1536);
assert.equal(runtime.modelArtifactSha256,sha(bytes['model.json']));assert.equal(runtime.modelRequests,0);
assert.equal(runtime.cases.length,model.cases.length);assert.equal(runtime.mismatches.length,0);
for(let index=0;index<model.cases.length;index++){
 const wanted=model.cases[index],actual=runtime.cases[index];assert.equal(actual.id,wanted.id);assert.deepEqual(actual.actual,wanted.expected);assert.ok(!actual.mismatch);
}
assert.equal(new Set(runtime.cases.map(row=>row.id)).size,1536);
assert.equal(runtime.mutations.length,9);assert.equal(new Set(runtime.mutations.map(row=>row.mutant)).size,9);
for(const row of runtime.mutations){
 const witness=model.witnesses.find(item=>item.mutant===row.mutant);assert.ok(witness);assert.equal(witness.solverStatus,'sat');assert.ok(witness.exhaustiveDisagreements>0);
 assert.deepEqual(row.input,witness.case);assert.deepEqual(row.expected,witness.expected);assert.deepEqual(row.mutatedExpected,witness.mutatedExpected);
 assert.deepEqual(row.baseline.actual,row.expected);assert.deepEqual(row.mutated.actual,row.mutatedExpected);assert.notDeepEqual(row.expected,row.mutatedExpected);
 assert.equal(row.mutation.beforeSha256,runtime.runtimeHashes[row.mutation.file]);assert.notEqual(row.mutation.beforeSha256,row.mutation.afterSha256);
}
assert.equal(runtime.deduplication.length,18);assert.equal(runtime.nonMutating.length,6);
for(const row of [...runtime.deduplication,...runtime.nonMutating])assert.deepEqual(row.observed.actual,row.expected);
assert.ok(runtime.mutations.some(row=>row.mutant==='no_files_as_pass'&&row.input.required&&row.input.mode==='no_files'&&!row.baseline.actual.requiredSatisfied));
assert.ok(runtime.mutations.some(row=>row.mutant==='drop_code_failure'&&row.baseline.actual.blocked&&!row.mutated.actual.blocked));
const result={artifacts:Object.fromEntries(Object.entries(bytes).map(([name,value])=>[name,sha(value)])),modelRequests:0,boundedCases:1536,boundedMismatches:0,concreteMutationWitnesses:9,deduplicationControls:18,nonMutatingControls:6,verification:'Artifact bindings and all stored baseline/mutation expectations match. Does not rerun Z3, reconstruct runtime fixtures or prove unbounded/source semantics.'};
if(output){await access(output).then(()=>{throw Error('Refusing to overwrite verification');},error=>{if(error.code!=='ENOENT')throw error;});await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify(result));
