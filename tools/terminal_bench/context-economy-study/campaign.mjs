import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir,cp,symlink,rm,access,realpath} from 'node:fs/promises';
import {join,relative,dirname} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {tasks,work,study,repo,instruction,checksFor,baselineModules} from './inputs.mjs';
import {endpoint,attachDependencies,applyOfficial} from './controls.mjs';
import {requiredEvidence} from './required-evidence.mjs';
import {DurableCampaign,atomicJson,digest,trialName} from '../durable-campaign.mjs';
import {prepareIsolatedNodeEnvironment,dependencyManifest,compareDependencyManifests} from '../isolated-node-environment.mjs';
import {reconcileUsage} from '../corpus/light-study-accounting.mjs';
import {sourceEpoch} from './source-epoch.mjs';
import {unwrapFeedbackEnvelope} from '../../../packages/agent-runtime/dist/tool-result-envelope.js';
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const lines=async path=>(await readFile(path,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e})).split('\n').filter(Boolean).map(line=>JSON.parse(line));
const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
const campaign=join(work,'campaign'),active=join(work,'active'),root=join(active,'workspace');
async function hashes(directory){const out={};for(const entry of await readdir(directory,{recursive:true,withFileTypes:true}))if(entry.isFile())out[relative(directory,join(entry.parentPath,entry.name))]=digest(await readFile(join(entry.parentPath,entry.name)));return out;}
async function sdkBindings(){
 const sdk=await realpath(join(repo,'packages/agent-runtime/node_modules/@cline/sdk/dist/index.js'));
 const core=await realpath(join(dirname(sdk),'../../core/dist/index.js'));
 const llms=await realpath(join(dirname(core),'../../llms/dist/index.js'));
 const files={sdk,core,llms,providers:join(dirname(llms),'providers.js')},out={};
 for(const [name,path]of Object.entries(files))out[name]={path,sha256:digest(await readFile(path))};
 return out;
}
const sharedScripts=['durable-campaign.mjs','isolated-node-environment.mjs','corpus/light-study-accounting.mjs','navigation-evidence/wire-audit.mjs','request-timing-preload.mjs','feedback-delivery-study/controls.mjs','feedback-delivery-study/receipt-metadata.mjs'];
async function sharedBindings(){const out={};for(const path of sharedScripts)out[path]=digest(await readFile(join(import.meta.dirname,'..',path)));return out;}
async function freeze(){
 const registration=await json(join(study,'selection-registration.json')),controls=await json(join(work,'controls.json'));
 assert.ok((await json(join(work,'sdk-controls.json'))).reports.every(r=>r.unchangedForwardedPrefix&&r.failedCheckStillFailed));
 assert.equal(controls.complete,true);assert.equal(controls.sourceHashes.controls,digest(await readFile(join(import.meta.dirname,'controls.mjs'))));
 const frozen=join(work,'frozen/model');await access(frozen).then(()=>{throw Error('Refuse replacing executable binding')},e=>{if(e.code!=='ENOENT')throw e});
 for(const name of ['agent-runtime','benchmark-runner']){
  const from=join(repo,'packages',name),to=join(frozen,name);await mkdir(to,{recursive:true});await cp(join(from,'dist'),join(to,'dist'),{recursive:true});await cp(join(from,'package.json'),join(to,'package.json'));
  if(name==='agent-runtime')await symlink(join(from,'node_modules'),join(to,'node_modules'));else{await mkdir(join(to,'node_modules/@blame'),{recursive:true});await symlink(join(frozen,'agent-runtime'),join(to,'node_modules/@blame/agent-runtime'));}
 }
 const order=[];for(const panel of registration.panels)for(let repeat=1;repeat<=registration.repetitions;repeat++)for(let t=0;t<panel.tasks.length;t++)for(let a=0;a<panel.arms.length;a++)order.push({panel:panel.id,repeat,task:panel.tasks[t].id,arm:panel.arms[(a+t+repeat-1)%panel.arms.length]});
 const sourceHead=git(repo,['rev-parse','HEAD']).trim(),boundScripts={};for(const entry of await readdir(import.meta.dirname))if(entry.endsWith('.mjs'))boundScripts[entry]=digest(await readFile(join(import.meta.dirname,entry)));
 for(const task of tasks)sourceEpoch(join(work,'inputs',task.id));
 const dependencies={};for(const task of tasks)dependencies[task.id]={modules:baselineModules(task),manifestSha256:digest(JSON.stringify(await dependencyManifest(baselineModules(task))))};
 const protocol={...registration,provider:registration.model.provider,model:registration.model.model,effort:registration.model.effort,registeredSourceHead:registration.sourceHead,sourceHead,boundAtUTC:new Date().toISOString(),order,observationBoundary:await json(join(study,'pre-dispatch-boundary.json')),dependencies,inputs:await json(join(work,'input-manifest.json')),oracleFiles:await hashes(join(work,'official')),runtimeFiles:await hashes(frozen),sdkFiles:await sdkBindings(),sharedScripts:await sharedBindings(),boundScripts,lockSha256:digest(await readFile(join(repo,'pnpm-lock.yaml'))),node:process.version,platform:process.platform,arch:process.arch,budgets:{...registration.budgets,requestOvershootReserveUsd:registration.budgets.perTrialMissingCostReserveUsd}};
 await atomicJson(join(study,'model-protocol.json'),protocol,{exclusive:true});await atomicJson(join(study,'oracle-controls.json'),controls,{exclusive:true});
 console.log('Bound '+order.length+' immutable assignments; no model request.');
}
async function validateBindings(p){
 assert.deepEqual(await hashes(join(work,'frozen/model')),p.runtimeFiles);
 assert.deepEqual(await hashes(join(work,'official')),p.oracleFiles);
 assert.deepEqual(await sdkBindings(),p.sdkFiles);assert.deepEqual(await sharedBindings(),p.sharedScripts);
 for(const value of Object.values(p.dependencies))assert.equal(digest(JSON.stringify(await dependencyManifest(value.modules))),value.manifestSha256);
 for(const [path,sha]of Object.entries(p.boundScripts))assert.equal(digest(await readFile(join(import.meta.dirname,path))),sha,'Script changed: '+path);
 assert.equal(digest(await readFile(join(repo,'pnpm-lock.yaml'))),p.lockSha256);
 for(const [key,expected]of Object.entries({BLAME_PROVIDER_ID:p.provider,BLAME_MODEL_ID:p.model,BLAME_REASONING_EFFORT:p.effort}))assert.equal(process.env[key],expected,key);
 assert.ok(process.env.BLAME_API_TOKEN);
}
async function prepare(directory,task,p){
 await rm(active,{recursive:true,force:true});await mkdir(root,{recursive:true});
 const archive=join(work,'inputs',task.id+'.tar.gz');assert.equal(digest(await readFile(archive)),p.inputs[task.id].archiveSha256);execFileSync('tar',['-xzf',archive,'-C',root]);
 assert.equal(git(root,['rev-parse','HEAD']).trim(),p.inputs[task.id].head);
 const isolated=await prepareIsolatedNodeEnvironment({baselineModules:baselineModules(task),workspace:root,cacheRoot:join(active,'npm-cache')});
 assert.equal(digest(JSON.stringify(isolated.manifest)),p.dependencies[task.id].manifestSha256,'Baseline dependencies changed');
 if(task.panel==='F69'){await mkdir(join(root,'node_modules/@tanstack'),{recursive:true});for(const name of ['query-core','react-query','query-test-utils'])await symlink('../../packages/'+name,join(root,'node_modules/@tanstack',name));}
 isolated.manifest=await dependencyManifest(join(root,'node_modules'));
 isolated.env.PATH=join(root,'node_modules/.bin')+':'+process.env.PATH;
 const quote=value=>"'"+value.replaceAll("'","'\\''")+"'",shell=Object.entries(isolated.env).map(([k,v])=>'export '+k+'='+quote(v)).join('\n')+'\n';
 await writeFile(join(active,'shell-environment.sh'),shell);isolated.env.BASH_ENV=join(active,'shell-environment.sh');
 await atomicJson(join(directory,'environment.json'),isolated);await writeFile(join(directory,'instruction.txt'),instruction(task)+'\n');await atomicJson(join(directory,'required-checks.json'),checksFor(task));
 assert.equal(git(root,['status','--porcelain']).trim(),'','Input must be clean before dispatch');
 return isolated;
}
async function model(slot,directory,p,isolated){
 const imports=['--import',join(repo,'tools/terminal_bench/navigation-evidence/wire-audit.mjs'),'--import',join(repo,'tools/terminal_bench/request-timing-preload.mjs'),'--import',join(import.meta.dirname,'receipt-audit.mjs'),'--import',join(import.meta.dirname,'source-audit.mjs')];
 const args=[...imports,join(work,'frozen/model/benchmark-runner/dist/cli.js'),'run','--workspace',root,'--instruction-file',join(directory,'instruction.txt'),'--required-checks-file',join(directory,'required-checks.json'),'--task-id',slot.task,'--events',join(directory,'events.jsonl'),'--result',join(directory,'result.json'),'--harness',slot.arm==='cline'?'cline':'blame','--max-iterations',String(p.budgets.maxIterations),'--timeout-seconds',String(p.budgets.timeoutSeconds)];
 const flags=p.featureFlags[slot.arm],env={...process.env,...isolated.env,NODE_PATH:'',NODE_USE_ENV_PROXY:'1',BLAME_HEADLESS_DEV:'true',NODE_ENV:'development',TZ:'UTC',BLAME_AGENT_REPAIR_CONTEXT_COMPACTION:String(flags.compact),BLAME_AGENT_LITERAL_FILE_SEARCH:String(flags.navigation),BLAME_AGENT_LITERAL_COMPILER_REPAIR:'true',BLAME_AGENT_SYMBOLIC_ANALYSIS:'false',BLAME_AGENT_SYMBOLIC_HINTS:'false',BLAME_AGENT_REQUEST_MAX_OUTPUT_TOKENS:String(p.budgets.maxOutputTokens),BLAME_AGENT_MAX_SESSION_COST_USD:String(p.budgets.perTrialSdkCostLimitUsd),BLAME_STUDY_REQUEST_MAX_BYTES:String(p.budgets.requestBytes),BLAME_STUDY_WORKSPACE:root,BLAME_STUDY_WIRE_AUDIT:join(directory,'wire-contracts.jsonl'),BLAME_STUDY_TIMING_AUDIT:join(directory,'request-timing.jsonl'),BLAME_STUDY_RECEIPT_AUDIT:join(directory,'receipt-metadata.jsonl'),BLAME_STUDY_SOURCE_AUDIT:join(directory,'source-epochs.jsonl'),BLAME_STUDY_FROZEN_RECORDER:join(work,'frozen/model/benchmark-runner/dist/event-recorder.js')};
 return await new Promise(resolve=>{
  const started=performance.now(),child=spawn(process.execPath,args,{cwd:repo,env,detached:true,stdio:['ignore','ignore','pipe']});let stderr='',watchdog=false;
  child.stderr.on('data',chunk=>{if(stderr.length<16000)stderr+=chunk});
  const timer=setTimeout(()=>{watchdog=true;process.kill(-child.pid,'SIGKILL')},(p.budgets.timeoutSeconds+30)*1000);
  child.once('error',error=>{clearTimeout(timer);resolve({code:null,signal:null,spawnError:error.code,stderr:'',durationMs:performance.now()-started})});
  child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,watchdog,durationMs:performance.now()-started,stderr:stderr.replaceAll(process.env.BLAME_API_TOKEN,'[REDACTED]')})});
 });
}
async function grade(directory,task,p){
 const head=p.inputs[task.id].head,untracked=git(root,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
 let patch=git(root,['diff','--binary',head]);for(const path of untracked){const {spawnSync}=await import('node:child_process');const r=spawnSync('git',['diff','--no-index','--binary','--','/dev/null',path],{cwd:root,encoding:'utf8'});assert.ok([0,1].includes(r.status));patch+=r.stdout;}
 await writeFile(join(directory,'workspace.diff'),patch);
 const changed=[...new Set([...git(root,['diff','--name-only','-z',head]).split('\0').filter(Boolean),...untracked])];
 const originalPaths=new Set(git(root,['ls-tree','-r','--name-only',head]).trim().split('\n'));
 const originalTests=new Set([...originalPaths].filter(p=>p.includes('/__tests__/')||/\.(?:test|spec)(?:-d)?\.tsx?$/u.test(p)));
 const scope=task.scope??['src'];
 const allowed=changed.filter(path=>scope.some(s=>path.startsWith(s+'/'))&&/\.tsx?$/u.test(path)&&!originalTests.has(path));
 const protectedPaths=changed.filter(path=>!allowed.includes(path)),deleted=git(root,['diff','--diff-filter=D','--name-only',head]).trim().split('\n').filter(Boolean);
 const newTests=changed.filter(path=>!originalPaths.has(path)&&/\.test(?:-d)?\.tsx?$/u.test(path)&&allowed.includes(path));
 const {lstat}=await import('node:fs/promises');const symlinks=[];for(const path of allowed)try{if((await lstat(join(root,path))).isSymbolicLink())symlinks.push(path);}catch(e){if(e.code!=='ENOENT')throw e;}
 const regular=allowed.filter(path=>!symlinks.includes(path));
 async function tree(name,includeTests){const to=join(directory,name);await rm(to,{recursive:true,force:true});await mkdir(to,{recursive:true});execFileSync('tar',['-xzf',join(work,'inputs',task.id+'.tar.gz'),'-C',to]);await attachDependencies(to,task);for(const path of regular){if(!includeTests&&path.includes('/__tests__/'))continue;try{await mkdir(join(to,path,'..'),{recursive:true});await cp(join(root,path),join(to,path));}catch(e){if(e.code!=='ENOENT')throw e;await rm(join(to,path),{force:true});}}return to;}
 const audit=await tree('independent-endpoint',true),endpoints=[];for(const check of checksFor(task))endpoints.push(await endpoint(audit,check.id,task));
 const official=await tree('official-endpoint',false);await applyOfficial(official,task);endpoints.push(await endpoint(official,'official',task));
 if(task.panel==='F69')endpoints.push(await endpoint(official,'probe',task));
 await atomicJson(join(directory,'endpoints.json'),endpoints);
 const before=(await json(join(directory,'environment.json'))).manifest,after=(await json(join(directory,'dependencies-at-exit.json'))).manifest,dependencies=compareDependencyManifests(before,after);await atomicJson(join(directory,'dependencies-after.json'),{manifest:after,comparison:dependencies});
 const sourceSuccess=endpoints.every(r=>r.exitCode===0)&&protectedPaths.length===0&&deleted.length===0&&symlinks.length===0&&dependencies.pinnedDependenciesUnchanged;
 return {sourceSuccess,strictLayout:newTests.length>0,protectedPaths,deleted,symlinks,newTests,changedPaths:changed,dependencyComparison:dependencies,endpoints:endpoints.map(({stdout,stderr,...r})=>r)};
}
async function analyse(slot,directory,p){
 const result=await json(join(directory,'result.json')).catch(()=>({})),events=(await lines(join(directory,'events.jsonl'))).map(row=>row.event),wire=await lines(join(directory,'wire-contracts.jsonl')),receipts=await lines(join(directory,'receipt-metadata.jsonl'));
 const iterations=events.filter(e=>e?.type==='notice'&&e.payload?.message==='Agent iteration started.').length;
 const usage=reconcileUsage(result.usage,events.filter(e=>e?.type==='usage').map(e=>e.payload?.usage),iterations);
 const tools=events.filter(e=>e?.type==='tool'&&e.payload?.phase==='finished').map(e=>({...e.payload,tool:e.payload.toolCall?.name??e.payload.tool,input:e.payload.toolCall?.input??e.payload.input,output:unwrapFeedbackEnvelope(e.payload.output)}));await atomicJson(join(directory,'tool-ledger.json'),tools);
 const task=tasks.find(t=>t.id===slot.task),scored=await grade(directory,task,p),official=result.status==='succeeded';
 const epochs=await lines(join(directory,'source-epochs.jsonl')),finalEpoch=(await json(join(directory,'source-at-exit.json'))).sha256;
 const freshToolIds=new Set();for(const e of epochs.filter(e=>e.phase==='finished')){const start=epochs.find(s=>s.phase==='started'&&s.callId===e.callId);if(start?.epoch?.sha256===finalEpoch&&e.epoch?.sha256===finalEpoch&&!start.error&&!e.error)freshToolIds.add(e.callId);}
 const evidence=requiredEvidence(tools,epochs,finalEpoch,checksFor(task),root);
 const required=evidence.every(c=>c.passedOnFinalSource);
 const admitted=checksFor(task).map(c=>({id:c.id,admitted:result.completion?.satisfied_obligations?.includes('check:'+c.id)??false}));
 const plan=t=>{if(t.output?.data?.validationRepair)return t.output.data.validationRepair;try{return JSON.parse(t.output?.recovery?.split('\n').at(-1)).validationRepair;}catch{return undefined}};
 const compilerOffers=tools.flatMap((t,index)=>{const offered=plan(t)?.repairFirst?.filter(v=>v.input.kind==='command')??[];return offered.map(v=>{const next=tools.findIndex((n,i)=>i>index&&n.tool==='run_task'&&['project','command'].includes(n.input?.kind));return {index,input:v.input,nextValidationIndex:next<0?null:next,directCompilerFollow:next>=0&&tools[next].input?.command===v.input.command};});});
 // Inspect executable/navigation requests, never URLs quoted in authored code.
 const retrievalRequests=tools.filter(t=>!['edit_code','apply_patch','write_file'].includes(t.tool)).map(t=>({name:t.tool,input:t.input}));
 const solutionRetrieval=/\b(?:curl|wget)\b|https?:\/\/|\/workspace\/Blame\/(?:docs|tools)|git\s+(?:fetch|clone|pull)/.test(JSON.stringify(retrievalRequests));
 const matching=new Map();for(const row of receipts){const q=matching.get(row.requestBodySha256)??[];q.push(row);matching.set(row.requestBodySha256,q)}
 let receiptRequests=0,scopeReceipts=0;for(const row of wire){const next=matching.get(row.requestBodySha256)?.shift();if(next&&!row.budgetRejected){receiptRequests++;scopeReceipts+=next.receipts.length;}}
 const exit=await json(join(directory,'model-exit.json'));
 const row={...slot,name:trialName(slot),officialRuntimeSuccess:official,requiredInvocationsReported:required,requiredEvidence:evidence,admittedRequiredChecks:admitted,strictSuccess:official&&required&&scored.sourceSuccess&&scored.strictLayout&&!solutionRetrieval,sourceSuccess:scored.sourceSuccess,score:scored,solutionRetrieval,usage,sdkDurationMs:result.durationMs??null,exit,status:result.status??'missing',completion:result.completion??null,
  forwardedRequests:wire.filter(r=>!r.budgetRejected).length,scopeReceipts,receiptRequests,groupedReads:tools.filter(t=>t.tool==='read_code'&&Array.isArray(t.input?.reads)).length,compilerRepairOffers:compilerOffers.length,compilerOffers,sourceAuditObservationMs:epochs.reduce((n,e)=>n+e.observationMs,0),toolTimeMs:tools.reduce((n,t)=>n+(t.durationMs??0),0),hashes:{}};
 const firstSchemas=[...new Set(wire.map(r=>r.toolsSha256))];row.actualSchemaHashes=firstSchemas;return {row,wire};
}
export async function run({studyRoot=study,campaignRoot=campaign,maxNewTrials=Infinity}={}){
 const path=join(studyRoot,'model-protocol.json'),p=await json(path);await validateBindings(p);
 const durable=new DurableCampaign({campaign:campaignRoot,study:studyRoot,protocol:p,protocolHash:digest(await readFile(path))});await durable.acquire();
 try{let rows=[],newTrials=0;for(const slot of p.order){
  const state=await durable.inspect(slot),directory=join(campaignRoot,trialName(slot));
  if(state.state==='complete'){rows.push(state.row);continue;}
  assert.ok(['unstarted','finalize'].includes(state.state));
  if(state.state==='finalize'){
   const archive=await json(join(directory,'workspace-archive.json'));assert.equal(digest(await readFile(join(directory,'workspace.tar.gz'))),archive.sha256);
   await rm(active,{recursive:true,force:true});await mkdir(root,{recursive:true});execFileSync('tar',['-xzf',join(directory,'workspace.tar.gz'),'-C',root]);await prepareIsolatedNodeEnvironment({baselineModules:baselineModules(tasks.find(t=>t.id===slot.task)),workspace:root,cacheRoot:join(active,'npm-cache')});
   assert.equal(sourceEpoch(root).sha256,(await json(join(directory,'source-at-exit.json'))).sha256);
   const analysed=await analyse(slot,directory,p);await atomicJson(join(directory,'score.json'),analysed.row);await durable.checkpoint(analysed.row,analysed.wire);rows.push(analysed.row);continue;
  }
  const spent=rows.reduce((n,r)=>n+(r.usage.cost??0)+(r.usage.cost===null?p.budgets.perTrialMissingCostReserveUsd:0),0);
  if(spent+p.budgets.perTrialSdkCostLimitUsd+p.budgets.perTrialMissingCostReserveUsd>p.budgets.observedStudyStopUsd){await atomicJson(join(campaignRoot,'budget-stop.json'),{spent,slot});break;}
  await mkdir(directory,{recursive:true});const task=tasks.find(t=>t.id===slot.task),isolated=await prepare(directory,task,p);
  console.log('START',trialName(slot));await durable.begin(slot);const exit=await model(slot,directory,p,isolated);await atomicJson(join(directory,'model-exit.json'),exit,{exclusive:true});
  await atomicJson(join(directory,'source-at-exit.json'),sourceEpoch(root),{exclusive:true});await atomicJson(join(directory,'dependencies-at-exit.json'),{manifest:await dependencyManifest(join(root,'node_modules'))},{exclusive:true});
  execFileSync('tar',['-czf',join(directory,'workspace.tar.gz'),'--exclude=node_modules','-C',root,'.']);await atomicJson(join(directory,'workspace-archive.json'),{sha256:digest(await readFile(join(directory,'workspace.tar.gz')))},{exclusive:true});
  assert.equal(sourceEpoch(root).sha256,(await json(join(directory,'source-at-exit.json'))).sha256,'Source moved while archiving');
  const analysed=await analyse(slot,directory,p);await atomicJson(join(directory,'score.json'),analysed.row);await durable.checkpoint(analysed.row,analysed.wire);rows.push(analysed.row);await atomicJson(join(campaignRoot,'rows.json'),rows);
  console.log('END',trialName(slot),'official='+analysed.row.officialRuntimeSuccess,'audit='+analysed.row.strictSuccess,'tokens='+[analysed.row.usage.input,analysed.row.usage.output].join('+'),'sdkUsd='+analysed.row.usage.cost);
  if(!analysed.row.forwardedRequests&&!analysed.row.officialRuntimeSuccess){await atomicJson(join(campaignRoot,'access-stop.json'),{slot,status:analysed.row.status,exit});break;}
  if(++newTrials>=maxNewTrials)break;
 }
 await atomicJson(join(studyRoot,'campaign-status.json'),{complete:rows.length===p.order.length,completed:rows.length,planned:p.order.length});
 }finally{await durable.release();}
}
if(process.argv[1]===import.meta.filename){const action=process.argv[2];if(action==='freeze')await freeze();else if(action==='run')await run({maxNewTrials:1});else throw Error('Expected freeze or run');}
