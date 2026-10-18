import {feedbackWireObservation} from './feedback-wire-metadata.mjs';
import {feedbackObservations} from './feedback-observations.mjs';
import {provenanceObservations,provenanceWireObservation} from './provenance-observations.mjs';
import {requestTimingObservation} from '../latency-intervals.mjs';
import {DurableCampaign, atomicWrite} from '../durable-campaign.mjs';
// F53 optional Z3 reasoning exposure: same runtime, one Light feature flag.
// Research setup/grading are outside the measured model worker.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readFile, readdir, realpath, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {solverIdentity} from './solver-identity.mjs';
import {schemaExposure} from './schema-exposure.mjs';
import {readJsonLines,readResult,finishObservation} from './evidence-io.mjs';
import {dependencyManifest,compareDependencyManifests} from '../isolated-node-environment.mjs';
import { reconcileUsage } from '../corpus/light-study-accounting.mjs';
import { reserveTrialCosts } from '../navigation-evidence/budget-accounting.mjs';
import { repo, work, study, sha, json, save, prepare, sourceRoot } from './setup.mjs';
import {check,checkNames} from './checks.mjs';

const protocol = await json(join(study, 'protocol.json'));
const campaign = join(work, 'campaign');
const storage = new DurableCampaign({campaign, study, protocol, protocolHash: sha(await readFile(join(study,'protocol.json')))});
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
export async function fileTree(root) {
  const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async path => [relative(root, path), sha(await readFile(path))])));
}
async function bindings() {
  const files = {};
  for (const path of [...protocol.boundScripts,'tools/terminal_bench/durable-campaign.mjs']) files[path] = sha(await readFile(join(repo,path)));
  files['isolated-node-environment.mjs'] = sha(await readFile(join(import.meta.dirname,'../isolated-node-environment.mjs')));
  for (const root of [join(work, 'frozen'), join(work, 'dependencies/node_modules')])
    files[relative(repo, root)] = await fileTree(root);
  for (const path of ['protocol.json', 'prior-budget.json', 'prompt-date-binding.json', 'native-search-bindings.json', 'isolation-controls.json', 'oracle-controls.json', 'input-archives.json', 'environment-smoke.json', 'snapshot.json', 'preflight-controls.json',...(protocol.feedbackWireAudit?['feedback-boundary-controls.json','measurement-amendment.json']:[]),...(protocol.requestTimingAudit?['timing-controls.json','contract-test-sensitivity.json','selection-registration.json']:[])])
    files[path] = sha(await readFile(join(study, path)));
  for (const path of ['tools/terminal_bench/navigation-evidence/wire-audit.mjs', 'tools/terminal_bench/navigation-evidence/native-search-repair.mjs',
    'tools/terminal_bench/request-limit-model-study/prompt-date.mjs', 'tools/terminal_bench/navigation-evidence/budget-accounting.mjs',
    'tools/terminal_bench/corpus/light-study-accounting.mjs', 'packages/agent-runtime/dist/usage-audit.js', 'pnpm-lock.yaml']) files[path] = sha(await readFile(join(repo, path)));
  for (const name of ['@cline/sdk', '@cline/llms','@blame/harness-core','@blame/model-catalog','@blame/preview-contract','@blame/telemetry']) {
    const path = join(repo, 'packages/agent-runtime/node_modules', name, 'dist');
    files[name] = await fileTree(path);
  }
  const sdk = await realpath(join(repo, 'packages/agent-runtime/node_modules/@cline/sdk'));
  files['@cline/core'] = await fileTree(join(dirname(sdk), 'core/dist'));
  const settings = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('BLAME_AGENT_') || key.startsWith('CLINE_MESSAGE_BUILDER_')).sort());
  const solver=await solverIdentity(protocol.solver.path);assert.deepEqual(solver,protocol.solver,'Solver or dynamic dependency changed');
  const runtimeDependencyResolution={};for(const arm of ['current','reference']){runtimeDependencyResolution[arm]=createRequire(join(work,'frozen',arm,'benchmark-runner/dist/cli.js')).resolve('@blame/agent-runtime');assert.equal(runtimeDependencyResolution[arm],join(work,'frozen',arm,'agent-runtime/dist/index.js'),'Runner must use its own frozen runtime');}
  return { solver, runtimeDependencyResolution, files, node: process.version, platform: process.platform, arch: process.arch, release: os.release(),
    cpuModels: os.cpus().map(cpu => cpu.model), totalMemoryBytes: os.totalmem(), inheritedSettingsSha256: sha(JSON.stringify(settings)) };
}
async function verifyBindings() {
  assert.deepEqual(await bindings(), await json(join(study, 'execution-bindings.json')), 'Frozen inputs changed');
  for (const [key, value] of Object.entries({ BLAME_MODEL_ID: protocol.model, BLAME_REASONING_EFFORT: protocol.effort,
    BLAME_PROVIDER_ID: protocol.provider, BLAME_API_URL: protocol.apiUrl })) assert.equal(process.env[key], value, key);
  assert.ok(process.env.BLAME_API_TOKEN, 'Configured API credential unavailable');
}
export async function score(directory, task) {
  const workspace = join(directory, 'workspace');
  const inputCommit=(await readFile(join(directory,'input-commit.txt'),'utf8')).trim();assert.match(inputCommit,/^[a-f0-9]{40}$/);
  const paths=[...new Set([...git(['diff','--no-renames','--name-only','-z',inputCommit,'--'],workspace).split('\0'),...git(['ls-files','--others','--exclude-standard','-z'],workspace).split('\0')].filter(Boolean))];
  const originalTests=new Set(git(['ls-tree','-r','--name-only','-z',inputCommit],workspace).split('\0').filter(path=>/\.(?:test|spec)(?:-d)?\.ts$/.test(path)));
  const protectedPaths = paths.filter(path => !(path.startsWith(sourceRoot()+'/')&&path.endsWith('.ts')) || originalTests.has(path));
  // Reconstruct endpoint against original checks in a fresh tree. Never repair
  // model source or copy an oracle solution back into the agent workspace.
  const audit = join(directory, 'independent-endpoint'); await rm(audit,{recursive:true,force:true}); await prepare(audit, task);
  let diff = git(['diff', '--binary', inputCommit], workspace);
  for (const path of git(['ls-files', '--others', '--exclude-standard', '-z'], workspace).split('\0').filter(Boolean)) {
    const extra = spawnSync('git', ['diff', '--no-index', '--binary', '--', '/dev/null', path], { cwd: workspace, encoding: 'utf8' });
    assert.ok(extra.status === 1 || extra.status === 0, 'Untracked source capture failed'); diff += extra.stdout;
  }
  await writeFile(join(directory, 'workspace.diff'), diff);
  for (const path of paths) {
    if (protectedPaths.includes(path)) continue;
    try { await mkdir(join(audit, path, '..'), { recursive: true }); await cp(join(workspace, path), join(audit, path)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await rm(join(audit, path), { force: true }); }
  }
  const checks = ['regression', 'feature', 'types'].map(name => check(audit,name,task));
  const deliveredChecks = ['delivered','delivered-types'].map(name => check(audit,name,task));
  const addedTests=paths.filter(p=>p.startsWith(sourceRoot()+'/')&&/\.(?:test|spec)\.ts$/.test(p)&&spawnSync('git',['cat-file','-e',inputCommit+':'+p],{cwd:workspace,stdio:'ignore'}).status!==0);
  return { changedPaths: paths, protectedPaths, checks, deliveredChecks, addedTests, independentFunctionalSuccess: protectedPaths.length === 0 && checks.every(result => result.exitCode === 0),
    sourceHashes: Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(join(workspace, path)).then(sha, () => null)]))) };
}
async function endpointIdentity(directory) {
  const workspace=join(directory,'workspace'),inputCommit=(await readFile(join(directory,'input-commit.txt'),'utf8')).trim();
  const paths=[...new Set([...git(['ls-tree','-r','--name-only','-z',inputCommit],workspace).split('\0'),...git(['ls-files','-z'],workspace).split('\0'),...git(['ls-files','--others','--exclude-standard','-z'],workspace).split('\0')].filter(Boolean))].sort();
  return {inputCommit,files:Object.fromEntries(await Promise.all(paths.map(async path=>[path,await readFile(join(workspace,path)).then(sha,e=>{if(e.code==='ENOENT')return null;throw e;})])))};
}
async function execute(directory, slot, task) {
  const runtime = protocol.runtimeByArm[slot.arm];
  const runner = join(work, 'frozen', runtime, 'benchmark-runner/dist/cli.js');
  assert.equal(createRequire(runner).resolve('@blame/agent-runtime'),join(work,'frozen',runtime,'agent-runtime/dist/index.js'));
  const native = slot.arm === 'cline';
  const imports = ['--import', join(repo, 'tools/terminal_bench/navigation-evidence/wire-audit.mjs'),
    '--import', join(repo, 'tools/terminal_bench/request-limit-model-study/prompt-date.mjs'),
    ...(protocol.requestTimingAudit?['--import',join(repo,'tools/terminal_bench/request-timing-preload.mjs')]:[]),
    ...(protocol.feedbackWireAudit?['--import',join(import.meta.dirname,'feedback-wire-audit.mjs')]:[]),
    ...(native ? ['--import', join(repo, 'tools/terminal_bench/navigation-evidence/native-search-repair.mjs')] : [])];
  const args = [runner, 'run', '--workspace', join(directory, 'workspace'), '--instruction-file', join(directory, 'instruction.txt'),
    '--required-checks-file', join(directory, 'required-checks.json'), '--task-id', task.id, '--events', join(directory, 'events.jsonl'),
    '--result', join(directory, 'result.json'), '--harness', native ? 'cline' : 'blame', '--max-iterations', String(protocol.budgets.maxIterations), '--timeout-seconds', String(protocol.budgets.timeoutSeconds)];
  const isolated = await json(join(directory,'environment.json'));
  const env = { ...process.env, ...isolated.env, PATH: join(directory,'workspace/node_modules/.bin')+':'+process.env.PATH, NODE_PATH:'', NODE_USE_ENV_PROXY: '1', BLAME_HEADLESS_DEV: 'true', NODE_ENV: 'development', TZ: 'UTC',
    BLAME_STUDY_DATE_BINDING: join(study, 'prompt-date-binding.json'), BLAME_STUDY_DATE_AUDIT: join(directory, 'date-loads.jsonl'),
    BLAME_STUDY_NATIVE_SEARCH_BINDINGS: join(study, 'native-search-bindings.json'), BLAME_STUDY_NATIVE_SEARCH_AUDIT: join(directory, 'search-loads.jsonl'),
    BLAME_STUDY_WIRE_AUDIT: join(directory, 'wire-contracts.jsonl'), BLAME_STUDY_FEEDBACK_WIRE_AUDIT: join(directory,'feedback-wire.jsonl'), BLAME_STUDY_WORKSPACE: join(directory, 'workspace'),
    ...(protocol.requestTimingAudit?{BLAME_STUDY_TIMING_AUDIT:join(directory,'request-timing.jsonl')}:{}),
    ...(protocol.provenanceAudit?{BLAME_STUDY_PROVENANCE_AUDIT:'true'}:{}),
    BLAME_AGENT_SYMBOLIC_ANALYSIS: protocol.flagByArm[slot.arm], BLAME_AGENT_SYMBOLIC_HINTS: protocol.hintsByArm[slot.arm], BLAME_Z3_PATH: protocol.solver.path,
    BLAME_STUDY_REQUEST_MAX_BYTES: String(protocol.budgets.maximumSerializedRequestBytes), BLAME_AGENT_REQUEST_MAX_OUTPUT_TOKENS: '8192', BLAME_AGENT_MAX_SESSION_COST_USD: String(protocol.budgets.perTrialSdkCostLimitUsd) };
  return new Promise((done) => {
    const started = performance.now();
    let child;try{child=spawn(process.execPath,[...imports,...args],{cwd:repo,env,detached:true,stdio:['ignore','ignore','pipe']});}catch(error){done({code:null,signal:null,watchdog:false,durationMs:performance.now()-started,stderr:'',spawnError:{name:error.name,code:error.code??null,message:error.message}});return;}
    let stderr = '', watchdog = false;
    child.stderr.on('data', chunk => { if (stderr.length < 16384) stderr += chunk.toString(); });
    const timer = setTimeout(() => { watchdog = true; process.kill(-child.pid, 'SIGKILL'); }, (protocol.budgets.timeoutSeconds + protocol.budgets.outerWatchdogExtraSeconds) * 1000);
    child.once('error', error => {clearTimeout(timer);done({code:null,signal:null,watchdog:false,durationMs:performance.now()-started,stderr,spawnError:{name:error.name,code:error.code??null,message:error.message}});});
    child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal, watchdog, durationMs: performance.now() - started,
      stderr: stderr.replaceAll(process.env.BLAME_API_TOKEN, '[REDACTED]') }); });
  });
}
export async function analyse(slot, directory, exit, grade) {
  const eventEvidence=await readJsonLines(join(directory,'events.jsonl')),resultEvidence=await readResult(join(directory,'result.json')),wireEvidence=await readJsonLines(join(directory,'wire-contracts.jsonl'));
  const evidenceAnomalies={events:eventEvidence.anomalies,result:resultEvidence.anomalies,wire:wireEvidence.anomalies};
  const validEvents=eventEvidence.rows.filter((row,index)=>{if(row.event&&typeof row.event==='object')return true;evidenceAnomalies.events.push({reason:'invalid_event_record',index,sha256:sha(JSON.stringify(row))});return false;});
  const events=validEvents.map(row=>row.event),result=resultEvidence.value,wire=wireEvidence.rows.filter((row,index)=>{if(typeof row.model==='string'&&typeof row.toolsSha256==='string'&&/^[a-f0-9]{64}$/.test(row.toolsSha256))return true;evidenceAnomalies.wire.push({reason:'invalid_wire_record',index,sha256:sha(JSON.stringify(row))});return false;});
  const iterations = events.filter(event => event.type === 'notice' && event.payload?.message === 'Agent iteration started.').length;
  const usage = reconcileUsage(result.usage, events.filter(event => event.type === 'usage').map(event => event.payload?.usage), iterations);
  const tools = [],starts=new Map();let observedIteration=0;
  for(const [eventIndex,event]of events.entries()){
    if(event.type==='notice'&&event.payload?.message==='Agent iteration started.')observedIteration++;
    if(event.type==='tool'&&event.payload?.phase==='started')starts.set(event.payload.toolCallId??event.payload.toolCall?.id,eventIndex);
    if(event.type==='tool'&&event.payload?.phase==='finished')tools.push({...event.payload,observedIteration,observedStartIndex:starts.get(event.payload.toolCallId??event.payload.toolCall?.id)??null,
      tool:event.payload.toolCall?.name??event.payload.tool,input:event.payload.toolCall?.input??event.payload.input});
  }
  const recoveryOffers=[];
  for(const [index,t] of tools.entries())if(t.tool==='read_code'&&typeof t.output?.recovery==='string'){
    let hint;try{hint=JSON.parse(t.output.recovery);}catch{continue;}
    if(hint.kind!=='missing_workspace_path')continue;
    const followed=tools.findIndex((next,j)=>j>index&&next.observedIteration>t.observedIteration&&next.tool==='read_code'&&next.output?.status==='ok'&&hint.candidates.some(c=>next.input?.target?.replace(/^\.\//,'')===c.path));
    const nextNavigation=tools.map((next,j)=>({next,j})).filter(({next,j})=>j>index&&next.observedIteration>t.observedIteration&&['search_code','read_code'].includes(next.tool)&&next.observedStartIndex!==null).sort((a,b)=>a.next.observedStartIndex-b.next.observedStartIndex)[0]?.j??-1;
    recoveryOffers.push({index,observedIteration:t.observedIteration,requestedPath:hint.requestedPath,candidates:hint.candidates,followedReadIndex:followed<0?null:followed,directNextNavigation:followed>=0&&followed===nextNavigation});
  }
  const selectionFailures=tools.flatMap((tool,index)=>{const data=tool.output?.data?.completed?.data??tool.output?.data;return tool.tool==='run_task'&&data?.check?.selectionFailure==='no_test_files'?[{index,observedIteration:tool.observedIteration,command:data.command,check:data.check,recovery:tool.output.recovery??null}]:[]});
  const noTestFileOutputs=tools.filter(tool=>/No test files found, exiting with code 1/.test(JSON.stringify(tool.output)));
  const finishObservations=tools.flatMap((tool,index)=>tool.tool==='finish_task'?[finishObservation(tool,index)]:[]);
  const finishFailures=finishObservations.filter(item=>item.classification==='rejected');
  const compilerScopeObservations=[];
  for(const [index,t]of tools.entries()){
    if(t.tool!=='run_task')continue;
    const report=t.output?.data?.validation?.compilerScope??t.output?.data?.completed?.data?.validation?.compilerScope;
    if(!report)continue;
    const follow=tools.findIndex((next,j)=>j>index&&next.observedIteration>t.observedIteration&&next.tool==='run_task'&&/delivered/.test(JSON.stringify(next.input)));
    compilerScopeObservations.push({index,observedIteration:t.observedIteration,report,followedValidationIndex:follow<0?null:follow});
  }
  const forwarded = wire.filter(request => !request.budgetRejected);
  const schemas=[];for(const hash of new Set(forwarded.map(request=>request.toolsSha256))){const bytes=await readFile(join(directory,'schema-'+hash+'.json'));schemas.push({sha256:hash,bytes:bytes.length,...schemaExposure(bytes)});}
  const schemaExposurePassed=schemas.length===0||schemas.every(schema=>schema.analyzeExposed===false&&schema.runTaskPresent===(slot.arm!=='cline'));
  const symbolicObservations=tools.flatMap((tool,index)=>tool.tool==='run_task'&&tool.input?.kind==='analyze'?[{index,observedIteration:tool.observedIteration,input:tool.input,output:tool.output,followingTaskIndices:tools.flatMap((next,j)=>j>index&&next.observedIteration>tool.observedIteration&&next.tool==='run_task'&&next.input?.kind!=='analyze'?[j]:[])}]:[]);
  const navigationOffers=tools.flatMap((tool,index)=>{
    const data=tool.output?.data;if(tool.output?.status!=='ok')return [];
    const declaration=tool.tool==='search_code'&&Array.isArray(data?.declarationCandidates)&&data.declarationCandidates.length>0;
    const noop=tool.tool==='edit_code'&&data?.changed===false&&Array.isArray(data?.nextReads)&&/preserves parameters/.test(data.guidance??'');
    if(!declaration&&!noop)return [];
    const targets=declaration?data.declarationCandidates.flatMap(d=>[d.target,d.alias]).filter(Boolean):data.nextReads.map(d=>d.target);
    return [{index,observedIteration:tool.observedIteration,kind:declaration?'declarations':'repeated_noop',targets,
      followedIndices:tools.flatMap((next,j)=>j>index&&next.observedIteration>tool.observedIteration&&['read_code','search_code'].includes(next.tool)&&targets.includes(next.input?.target??next.input?.query)?[j]:[])}];
  });
  const symbolicHintOffers=tools.flatMap((tool,index)=>tool.tool==='read_code'&&Array.isArray(tool.output?.data?.symbolicAnalysis)?tool.output.data.symbolicAnalysis.map(hint=>({index,observedIteration:tool.observedIteration,target:hint.target,parameters:hint.parameters,followedAnalysisIndices:tools.flatMap((next,j)=>j>index&&next.observedIteration>tool.observedIteration&&next.tool==='run_task'&&next.input?.kind==='analyze'&&[hint.target,tool.output.data.alias].filter(Boolean).includes(next.input.target)?[j]:[])})):[]);
  const directSolverCommands=tools.filter(tool=>/\bz3\b|BLAME_Z3_PATH/.test(JSON.stringify(tool.input??{}))).map(tool=>({tool:tool.tool,input:tool.input,output:tool.output}));
  const feedbackEvidence=protocol.feedbackWireAudit?await readJsonLines(join(directory,'feedback-wire.jsonl')):null;
  const feedbackWire=feedbackEvidence?feedbackWireObservation(feedbackEvidence.rows,wire):null;
  const timingEvidence=protocol.requestTimingAudit?await readJsonLines(join(directory,'request-timing.jsonl')):null;
  const timing=timingEvidence?requestTimingObservation(timingEvidence.rows,wire):null;
  const provenanceWire=protocol.provenanceAudit?provenanceWireObservation(feedbackEvidence?.rows??[],wire):null;
  if(timingEvidence)evidenceAnomalies.timing=timingEvidence.anomalies;
  if(feedbackEvidence)evidenceAnomalies.feedback=feedbackEvidence.anomalies;
  const contractPassed = (!feedbackWire||feedbackWire.matched) && (!timing||timing.matched) && (!provenanceWire||provenanceWire.matched) && Object.values(evidenceAnomalies).every(items=>items.length===0) && !exit.spawnError && schemaExposurePassed && forwarded.every(request => request.maximumOutputTokens === 8192 && request.model === protocol.model && request.reasoning?.effort === protocol.effort)
    && usage.perRequest.every(report => report.output === null || report.output <= 8192) && !(usage.reports > 0 && forwarded.length === 0);
  await save(join(directory, 'tool-ledger.json'), tools);
  const row = { ...(feedbackWire?{feedbackWire}:{}), ...(timing?{timing}:{}), ...(provenanceWire?{provenanceWire,provenance:provenanceObservations(tools)}:{}), feedback:feedbackObservations(tools), ...slot, name: `${slot.repeat}-${slot.task}-${slot.arm}`, officialRuntimeSuccess: result.status === 'succeeded', status: result.status ?? 'missing',
    selectedCheckSuccess: grade.protectedPaths.length===0&&grade.checks.filter(c=>c.name!=='feature').every(c=>c.exitCode===0)&&grade.deliveredChecks.find(c=>c.name==='delivered')?.exitCode===0,
    independentFunctionalSuccess: grade.independentFunctionalSuccess, auditedCompletion: null, durationMs: result.durationMs ?? exit.durationMs,
    evidenceAnomalies,finishObservations,usage, metrics: result.metrics ?? null, completion: result.completion ?? null, error: result.error ?? null, exit,
    navigationOffers, symbolicHintOffers, symbolicObservations, symbolicCalls:symbolicObservations.length, symbolicCounterexamples:symbolicObservations.filter(row=>row.output?.data?.status==='counterexample').length, symbolicUnknowns:symbolicObservations.filter(row=>row.output?.data?.status==='unknown').length, symbolicBlockedCalls:symbolicObservations.filter(row=>row.output?.status==='blocked').length, directSolverCommands, schemas, schemaExposurePassed, requestBodyBytes:forwarded.reduce((sum,row)=>sum+row.requestBytes,0),
    selectionFailures, noTestFileOutputs:noTestFileOutputs.length, finishFailures:finishFailures.length,
    compilerScopeObservations, scopeFeedbackOffered:compilerScopeObservations.filter(o=>o.report.status==='reported'&&o.report.changedFilesNotReported.length>0).length,
    scopeFeedbackFollowed:compilerScopeObservations.filter(o=>o.report.status==='reported'&&o.report.changedFilesNotReported.length>0&&o.followedValidationIndex!==null).length,
    pathRecoveryOffered: recoveryOffers.length, pathRecoveryFollowed: new Set(recoveryOffers.map(r=>r.followedReadIndex).filter(i=>i!==null)).size, pathRecoveryDirectlyFollowed: recoveryOffers.filter(r=>r.directNextNavigation).length, recoveryOffers,
    declarationCalls: tools.filter(tool => tool.tool === 'read_code' && tool.input?.view === 'declaration').length,
    successfulDeclarationCalls: tools.filter(tool => tool.tool === 'read_code' && tool.output?.status === 'ok' && tool.output?.data?.view === 'declaration').length,
    blockedEdits: tools.filter(tool => tool.tool === 'edit_code' && tool.output?.status !== 'ok').length,
    contract: { passed: contractPassed, forwarded: forwarded.length, usageReports: usage.reports, unreported: Math.max(0, forwarded.length - usage.reports) },
    hashes: Object.fromEntries(await Promise.all(['events.jsonl', 'workspace.diff', 'score.json', 'tool-ledger.json',...(protocol.feedbackWireAudit?['feedback-wire.jsonl']:[]),...(protocol.requestTimingAudit?['request-timing.jsonl']:[])].map(async path =>
      [path, await readFile(join(directory, path)).then(sha, () => null)]))) };
  return { row, wire };
}
async function run() {
  await verifyBindings();
  const protocolPath = relative(repo, join(study, 'protocol.json'));
  assert.equal(git(['show', `HEAD:${protocolPath}`], repo), await readFile(join(study, 'protocol.json'), 'utf8'), 'Protocol must be committed before model launch');
  const {rows, wireByTrial} = await storage.restoreCompleted();
  const previousRows = new Set(rows.map(row=>row.name));
  assert.ok(rows.every(row=>row.contract.passed&&(row.contract.forwarded>0||row.officialRuntimeSuccess)),'A recorded contract stop requires inspection; resume must not bypass it');
  if(!await readFile(join(campaign,'provenance.json')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;})) await save(join(campaign, 'provenance.json'), { protocolSha256: sha(await readFile(join(study, 'protocol.json'))), startedAtUTC: new Date().toISOString(), order: protocol.order });
  await save(join(campaign,'analysis.json'),{planned:protocol.order.length,rows});
  const prior = await json(join(study, 'prior-budget.json')); let accounting = reserveTrialCosts(rows, wireByTrial, protocol.budgets);
  for (const slot of protocol.order) {
    if(previousRows.has(`${slot.repeat}-${slot.task}-${slot.arm}`)) continue;
    if (await readFile(join(work, 'pause-before-next-trial')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
      await save(join(campaign, 'administrative-pause.json'), { nextSlot: slot, modelRetried: false }); break;
    }
    await verifyBindings(); const task = protocol.tasks.find(task => task.id === slot.task);
    const name = `${slot.repeat}-${slot.task}-${slot.arm}`, state=await storage.inspect(slot), directory=state.directory;
    const reserve = protocol.budgets.perTrialSdkCostLimitUsd + protocol.budgets.requestOvershootReserveUsd;
    if (state.state==='unstarted'&&(accounting.accountedUsd + reserve > protocol.budgets.panelObservedCostStopUsd || prior.accountedUsd + accounting.accountedUsd + reserve > protocol.budgets.sharedStudyObservedCostStopUsd)) {
      await save(join(campaign, 'budget-stop.json'), { slot, accounting, prior, reserve }); break;
    }
    let exit;
    if(state.state==='finalize') {console.log('FINALIZE_WITHOUT_MODEL',name); exit=await json(join(directory,'model-exit.json'));}
    else {
      assert.equal(state.state,'unstarted');
      // No model-start record exists: incomplete preparation can safely be recreated.
      await rm(directory,{recursive:true,force:true}); await mkdir(directory);
      await prepare(join(directory,'workspace'),task.id,true);
      await atomicWrite(join(directory,'input-commit.txt'),git(['rev-parse','HEAD'],join(directory,'workspace')));
      await atomicWrite(join(directory,'instruction.txt'),task.instruction); await save(join(directory,'required-checks.json'),task.requiredChecks);
      await storage.begin(slot); console.log('START',name);
      exit=await execute(directory,slot,task); await save(join(directory,'endpoint-manifest.json'),await endpointIdentity(directory)); await save(join(directory,'model-exit.json'),exit);
    }
    assert.deepEqual(await endpointIdentity(directory),await json(join(directory,'endpoint-manifest.json')),'Source changed after recorded model exit');
    const grade = await score(directory, task.id);
    const environment = await json(join(directory,'environment.json'));
    const afterDependencies=await dependencyManifest(join(directory,'workspace/node_modules'));
    await save(join(directory,'dependency-after-manifest.json'),afterDependencies);
    grade.dependencyIntegrity = compareDependencyManifests(environment.manifest,afterDependencies);
    await save(join(directory, 'score.json'), grade);
    const { row, wire } = await analyse(slot, directory, exit, grade); rows.push(row); wireByTrial[name] = wire;
    await save(join(campaign, 'analysis.json'), { planned: protocol.order.length, rows });
    accounting = reserveTrialCosts(rows, wireByTrial, protocol.budgets); await save(join(campaign, 'accounting.json'), accounting);
    // Preserve exact worker files privately; publish diffs/traces and replay from pinned inputs.
    // Release extracted fixture inodes only after a successful archive and grade.
    execFileSync('tar', ['-czf', join(directory, 'workspace.tar.gz'), '--exclude=workspace/node_modules', '-C', directory, 'workspace']);
    await save(join(directory, 'workspace-archive.json'), { sha256: sha(await readFile(join(directory, 'workspace.tar.gz'))), includesJournal: true });
    await storage.checkpoint(row,wire); await storage.restoreCompleted();
    await rm(join(directory, 'workspace'), { recursive: true, force: true });
    await rm(join(directory, 'independent-endpoint'), { recursive: true, force: true });
    await rm(join(directory,'npm-cache'),{recursive:true,force:true});
    console.log('END', name, 'official=' + row.officialRuntimeSuccess, 'functional=' + row.independentFunctionalSuccess, 'tokens=' + (row.usage.input + row.usage.output), 'seconds=' + (row.durationMs / 1000).toFixed(1));
    if (!row.contract.passed || (row.contract.forwarded === 0 && !row.officialRuntimeSuccess)) { await save(join(campaign, 'contract-stop.json'), { name, contract: row.contract }); break; }
  }
  await save(join(campaign, 'driver-exit.json'), { completed: rows.length, planned: protocol.order.length, complete: rows.length === protocol.order.length,
    observedSdkUsd: accounting.observedUsd, newReservedUsd: accounting.reservedUsd, cumulativeAccountedUsd: prior.accountedUsd + accounting.accountedUsd });
}
if (process.argv[2] === 'bind') { await save(join(study, 'execution-bindings.json'), await bindings()); console.log('Frozen bindings written; no model requests.'); }
else if (['run','resume'].includes(process.argv[2])) {await storage.acquire();try{await run();}finally{await storage.release();}}
