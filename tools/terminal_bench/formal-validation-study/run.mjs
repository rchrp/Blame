// Admission-state differential harness. Automatic command scheduling is bypassed;
// all journal freshness/deduplication and actual finish admission logic are real.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, cp, symlink, rm, access} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
const runtime=resolve(process.argv[2]??''), modelPath=resolve(process.argv[3]??''), output=resolve(process.argv[4]??'');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const sha=value=>createHash('sha256').update(value).digest('hex');
await access(output).then(()=>{throw Error('Refusing to overwrite evidence');},error=>{if(error.code!=='ENOENT')throw error;});
const modelBytes=await readFile(modelPath), model=JSON.parse(modelBytes);
assert.equal(model.schemaVersion,1);assert.equal(model.cases.length,1536);
const boundFiles=['light-finish-service.js','session-journal.js','workspace-files.js','light-commit.js','light-validation-report.js'];
const runtimeHashes={};for(const name of boundFiles)runtimeHashes[name]=sha(await readFile(join(runtime,name)));
const researcherCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
const parent=await mkdtemp(join(tmpdir(),'blame-formal-f46-'));
const workspace=join(parent,'workspace');await mkdir(workspace);await writeFile(join(workspace,'value.js'),'exports.value = 2;\n');
let counter=0;
async function load(directory){const imported=await Promise.all(['workspace-files','session-journal','light-finish-service'].map(name=>import(pathToFileURL(join(directory,name+'.js')))));return{WorkspaceFiles:imported[0].WorkspaceFiles,SessionJournal:imported[1].SessionJournal,LightFinishService:imported[2].LightFinishService};}
const baseline=await load(runtime);
const required=[{id:'selected',input:{kind:'project',task:'test',args:['selected.test.js']},cwd:'.',taskKind:'test'}];
function testEvidence(mode){
 const pass=mode==='observed_pass', failed=['no_files','code_failure','environment_failure'].includes(mode);
 return{status:failed?'failed':'unknown',terminal:failed?'failed':'unknown',...(failed?{category:mode==='code_failure'?'code':mode==='no_files'?'command':'environment'}:{}),check:{process:'exited',exitCode:failed?1:0,execution:pass?'observed':mode==='zero_tests'?'zero_tests':'not_observed',outcome:failed?'failed':pass?'passed':'unknown',scope:'.',selection:'unknown',freshness:'unknown',evidenceOrigin:pass?'runner_output':'none',...(pass?{counts:{executed:1,passed:1,failed:0,skipped:0}}:{}),...(mode==='no_files'?{selectionFailure:'no_test_files'}:{})}};
}
async function exercise(caseValue, api=baseline, extra={}){
 const id=`case-${++counter}`, files=new api.WorkspaceFiles(workspace), journal=new api.SessionJournal(workspace,id);
 await writeFile(join(workspace,'value.js'),caseValue.fileCurrent?'exports.value = 2;\n':'exports.value = 1;\n');
 const finalRevision=caseValue.fileCurrent?(await files.snapshot()).revision.source_revision_id:null;
 // A mismatched hash with a matching revision is an adversarial journal state:
 // recordValidation hashes present bytes but accepts the caller's revision field.
 if(caseValue.present){
  if(!caseValue.fileCurrent)await writeFile(join(workspace,'value.js'),'exports.value = 2;\n');
  const expectedRevision=finalRevision??(await files.snapshot()).revision.source_revision_id;
  if(!caseValue.fileCurrent)await writeFile(join(workspace,'value.js'),'exports.value = 1;\n');
  await journal.recordValidation({taskId:caseValue.exactTask?'test':'other:test',taskKind:'test',cwd:caseValue.exactCwd?'.':'pkg',args:caseValue.exactArgs?['selected.test.js']:['other.test.js'],sourceRevisionId:caseValue.revisionCurrent?expectedRevision:'source://deliberately-stale',paths:['value.js'],...testEvidence(caseValue.mode)});
 }
 await writeFile(join(workspace,'value.js'),'exports.value = 2;\n');
 const sourceRevisionId=(await files.snapshot()).revision.source_revision_id;
 if(!extra.noChange)await journal.recordChange({paths:['value.js'],sourceRevisionId,receipt:'constructed-formal-state',symbols:[],parse:'not_supported'});
 if(caseValue.scopeEvidence)await journal.recordValidation({taskId:'build',taskKind:'build',cwd:'.',sourceRevisionId,paths:['value.js'],status:'passed',terminal:'passed'});
 if(extra.trailing){
  await journal.recordValidation({taskId:'test',taskKind:'test',cwd:'.',args:extra.trailing.different?['other.test.js']:['selected.test.js'],sourceRevisionId,paths:['value.js'],...testEvidence(extra.trailing.mode)});
 }
 const before=await journal.completionSnapshot(), notifications=[];
 const service=new api.LightFinishService({workspaceRoot:workspace,conversationId:id,onComplete:value=>notifications.push(value)});
 let schedulerBypasses=0;
 service.validateIfNeeded=async()=>{schedulerBypasses++;return{outcome:'checked',taskIds:['build','test','other:test'],required:caseValue.required?required:[]};};
 let error;
 try{await service.finish('Constructed admission-state study; no source acceptance claim.',{});}catch(value){error=value.message;}
 assert.ok(schedulerBypasses===0||schedulerBypasses===1);
 const notification=notifications.at(-1);
 const actual={blocked:Boolean(error),verification:notification?.completion.verification??null,requiredSatisfied:notification?!caseValue.required||notification.completion.satisfied_obligations.includes('check:selected'):null,currentTestRecords:before.validations.filter(v=>v.taskKind==='test').length};
 return{actual,error:error??null,schedulerBypasses,notification:notification?{verified:notification.verified,completion:notification.completion}:null,currentValidations:before.validations.map(v=>({taskId:v.taskId,cwd:v.cwd,args:v.args??[],status:v.status,terminal:v.terminal,category:v.category??null,check:v.check?{execution:v.check.execution,outcome:v.check.outcome,selectionFailure:v.check.selectionFailure??null}:null})),changedPaths:before.changedPaths};
}
const started=performance.now(), cases=[], mismatches=[];
for(const item of model.cases){
 const observed=await exercise(item);
 const matches=JSON.stringify(observed.actual)===JSON.stringify(item.expected);
 if(!matches)mismatches.push({id:item.id,input:item,observed});
 cases.push({id:item.id,actual:observed.actual,...(!matches?{mismatch:true,details:observed}:{})});
 if(cases.length%128===0)console.log(JSON.stringify({phase:'bounded-runtime',completed:cases.length,total:model.cases.length,mismatches:mismatches.length}));
}
const runtimeSeconds=(performance.now()-started)/1000;
const edits={
 drop_revision:['session-journal.js','validation.sourceRevisionId === sourceRevisionId &&','true &&'],
 drop_file_hash:['session-journal.js','(await this.allFilesCurrent(validation.files))','true'],
 drop_task:['light-finish-service.js','validation.taskId === input.task &&','true &&'],
 drop_argv:['light-finish-service.js','JSON.stringify(validation.args ?? []) === JSON.stringify(input.args ?? [])','true'],
 drop_cwd:['light-finish-service.js','(validation.cwd ?? ".") === cwd','true'],
 relax_test_evidence:['light-finish-service.js','validation.check.execution === "observed" && validation.check.outcome === "passed"','validation.check.exitCode === 0'],
 no_files_as_pass:['light-finish-service.js','if (validation.taskKind !== taskKind)','if (validation.check?.selectionFailure === "no_test_files") return true;\n    if (validation.taskKind !== taskKind)'],
 drop_required:['light-finish-service.js','const verified = scopeVerified && obligations.every(({ passed }) => passed);','const verified = scopeVerified;'],
 drop_code_failure:['light-finish-service.js','function assertNoFailedValidation(state) {','function assertNoFailedValidation(state) { return;'],
};
const mutationStarted=performance.now(), mutations=[];
for(const witness of model.witnesses){
 const mutantRoot=join(parent,'mutants',witness.mutant), dist=join(mutantRoot,'dist');
 await mkdir(mutantRoot,{recursive:true});await cp(dirname(runtime),dist,{recursive:true});
 await symlink(join(dirname(dirname(runtime)),'node_modules'),join(mutantRoot,'node_modules'),'dir');
 await writeFile(join(mutantRoot,'package.json'),'{"type":"module"}\n');
 const mutantRuntime=join(dist,'harness'), [name,needle,replacement]=edits[witness.mutant], target=join(mutantRuntime,name), before=await readFile(target,'utf8');
 assert.equal(before.split(needle).length-1,1,`Mutation must match exactly once: ${witness.mutant}`);
 const after=before.replace(needle,replacement);await writeFile(target,after);
 const api=await load(mutantRuntime), ordinary=await exercise(witness.case), altered=await exercise(witness.case,api);
 const matches=JSON.stringify(ordinary.actual)===JSON.stringify(witness.expected)&&JSON.stringify(altered.actual)===JSON.stringify(witness.mutatedExpected);
 mutations.push({mutant:witness.mutant,input:witness.case,expected:witness.expected,mutatedExpected:witness.mutatedExpected,baseline:ordinary,mutated:altered,matches,mutation:{file:name,beforeSha256:sha(before),afterSha256:sha(after),needle,replacement}});
}
const mutationSeconds=(performance.now()-mutationStarted)/1000;
const deduplication=[];
const baseCase={present:true,revisionCurrent:true,fileCurrent:true,exactTask:true,exactArgs:true,exactCwd:true,required:true,scopeEvidence:true,mode:'observed_pass'};
for(const firstMode of ['observed_pass','code_failure','no_files'])for(const lastMode of ['observed_pass','code_failure','no_files'])for(const different of [false,true]){
 const input={...baseCase,mode:firstMode}, observed=await exercise(input,baseline,{trailing:{mode:lastMode,different}});
 const active=different?[firstMode,lastMode]:[lastMode], blocked=active.includes('code_failure');
 const satisfied=(different?firstMode:lastMode)==='observed_pass';
 const expected={blocked,verification:blocked?null:satisfied?'verified':'unverified',requiredSatisfied:blocked?null:satisfied,currentTestRecords:different?2:1};
 deduplication.push({firstMode,lastMode,different,expected,observed,matches:JSON.stringify(expected)===JSON.stringify(observed.actual)});
}
const nonMutating=[];
for(const requiredCheck of [false,true])for(const outcome of ['observed_pass','unobserved','no_files']){
 const input={...baseCase,scopeEvidence:false,required:requiredCheck,mode:outcome};
 const observed=await exercise(input,baseline,{noChange:true});
 // Current non-mutating branch additionally requires passed status+terminal,
 // while test observations correctly remain status unknown: it stays unverified.
 const expected={blocked:false,verification:requiredCheck?'unverified':'not_applicable',requiredSatisfied:!requiredCheck||outcome==='observed_pass',currentTestRecords:1};
 nonMutating.push({required:requiredCheck,outcome,expected,observed,matches:JSON.stringify(expected)===JSON.stringify(observed.actual)});
}
for(const [name,hash]of Object.entries(runtimeHashes))assert.equal(sha(await readFile(join(runtime,name))),hash,'Runtime changed during study');
const studyScripts={};for(const name of ['model.py','run.mjs'])studyScripts[name]=sha(await readFile(join(dirname(fileURLToPath(import.meta.url)),name)));
const result={schemaVersion:1,modelRequests:0,researcherCommit,runtime,runtimeHashes,studyScripts,modelArtifactSha256:sha(modelBytes),method:'Prespecified synthetic journal states passed through actual SessionJournal.completionSnapshot and LightFinishService.finish. One per-instance validateIfNeeded override returns frozen required invocations and task IDs; automatic selection/execution/refresh are bypassed. Actual snapshot freshness, journal deduplication, failed-code guard, exact identity, observed test predicate, scope and obligations, and completion notifications are unchanged. Scratch production-code mutants are materialized only for solver witnesses.',limits:['Finite two-identity domain; no arbitrary program proof.','Journal events are constructed through recordValidation; stale matching-revision file hashes are intentionally adversarial and may not arise through ordinary runner calls.','Runner output parsing, process execution, scheduling, environment provenance and concurrent writers are outside the model.','Passing build path membership reflects current harness admission behavior; it does not prove semantic coverage or user acceptance.','No model calls, source correctness, task success, token/cost benefit or runtime solver integration demonstrated.'],timing:{runtimeComparisonSeconds:runtimeSeconds,mutationFixtureSeconds:mutationSeconds,scope:'One local wall-clock execution, host contention unknown. Scratch-copy/setup and filesystem snapshots dominate runtime measurements; solver/enumeration timings are separate in model.json.'},summary:{boundedCases:cases.length,boundedMismatches:mismatches.length,mutationControls:mutations.length,mutationControlsMatched:mutations.filter(x=>x.matches).length,deduplicationControls:deduplication.length,deduplicationMismatches:deduplication.filter(x=>!x.matches).length,nonMutatingControls:nonMutating.length,nonMutatingMismatches:nonMutating.filter(x=>!x.matches).length},cases,mismatches,mutations,deduplication,nonMutating};
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
await rm(parent,{recursive:true,force:true});console.log(JSON.stringify({output,summary:result.summary,timing:result.timing}));
if(mismatches.length||mutations.some(x=>!x.matches)||deduplication.some(x=>!x.matches)||nonMutating.some(x=>!x.matches))process.exitCode=1;
