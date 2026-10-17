// F47 constructed multi-package confirmation: F45 selection recovery alone.
// Research setup/grading are outside the measured model worker.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readFile, readdir, realpath, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import os from 'node:os';
import {dependencyManifest,compareDependencyManifests} from '../isolated-node-environment.mjs';
import { reconcileUsage } from '../corpus/light-study-accounting.mjs';
import { reserveTrialCosts } from '../navigation-evidence/budget-accounting.mjs';
import { repo, work, study, sha, json, save, prepare } from './setup.mjs';
import {check,checkNames} from './checks.mjs';

const protocol = await json(join(study, 'protocol.json'));
const campaign = join(work, 'campaign');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
export async function fileTree(root) {
  const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async path => [relative(root, path), sha(await readFile(path))])));
}
async function bindings() {
  const files = {};
  for (const path of protocol.boundScripts) files[path] = sha(await readFile(join(repo,path)));
  files['isolated-node-environment.mjs'] = sha(await readFile(join(import.meta.dirname,'../isolated-node-environment.mjs')));
  for (const root of [join(work, 'frozen'), join(work, 'dependencies/node_modules')])
    files[relative(repo, root)] = await fileTree(root);
  for (const path of ['protocol.json', 'prior-budget.json', 'prompt-date-binding.json', 'native-search-bindings.json', 'isolation-controls.json', 'oracle-controls.json', 'input-archives.json', 'environment-smoke.json'])
    files[path] = sha(await readFile(join(study, path)));
  for (const path of ['tools/terminal_bench/navigation-evidence/wire-audit.mjs', 'tools/terminal_bench/navigation-evidence/native-search-repair.mjs',
    'tools/terminal_bench/request-limit-model-study/prompt-date.mjs', 'tools/terminal_bench/navigation-evidence/budget-accounting.mjs',
    'tools/terminal_bench/corpus/light-study-accounting.mjs', 'pnpm-lock.yaml']) files[path] = sha(await readFile(join(repo, path)));
  for (const name of ['@cline/sdk', '@cline/llms']) {
    const path = join(repo, 'packages/agent-runtime/node_modules', name, 'dist');
    files[name] = await fileTree(path);
  }
  const sdk = await realpath(join(repo, 'packages/agent-runtime/node_modules/@cline/sdk'));
  files['@cline/core'] = await fileTree(join(dirname(sdk), 'core/dist'));
  const settings = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('BLAME_AGENT_') || key.startsWith('CLINE_MESSAGE_BUILDER_')).sort());
  return { files, node: process.version, platform: process.platform, arch: process.arch, release: os.release(),
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
  const paths = git(['status', '--porcelain', '--untracked-files=all'], workspace).trimEnd().split('\n').filter(Boolean).map(line => line.slice(3));
  const protectedPaths = paths.filter(path => !/^(?:packages|apps)\/.+\.ts$/.test(path) || path.endsWith('/original.test.ts'));
  // Reconstruct endpoint against original checks in a fresh tree. Never repair
  // model source or copy an oracle solution back into the agent workspace.
  const audit = join(directory, 'independent-endpoint'); await prepare(audit, task);
  let diff = git(['diff', '--binary', 'HEAD'], workspace);
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
  const addedTests=git(['ls-files','--others','--exclude-standard','-z'],workspace).split('\0').filter(p=>/^(?:packages|apps)\//.test(p)&&/\.(?:test|spec)\.ts$/.test(p));
  return { changedPaths: paths, protectedPaths, checks, deliveredChecks, addedTests, independentFunctionalSuccess: protectedPaths.length === 0 && checks.every(result => result.exitCode === 0),
    sourceHashes: Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(join(workspace, path)).then(sha, () => null)]))) };
}
async function execute(directory, slot, task) {
  const runtime = protocol.runtimeByArm[slot.arm];
  const runner = join(work, 'frozen', runtime, 'benchmark-runner/dist/cli.js');
  const native = slot.arm === 'cline';
  const imports = ['--import', join(repo, 'tools/terminal_bench/navigation-evidence/wire-audit.mjs'),
    '--import', join(repo, 'tools/terminal_bench/request-limit-model-study/prompt-date.mjs'),
    ...(native ? ['--import', join(repo, 'tools/terminal_bench/navigation-evidence/native-search-repair.mjs')] : [])];
  const args = [runner, 'run', '--workspace', join(directory, 'workspace'), '--instruction-file', join(directory, 'instruction.txt'),
    '--required-checks-file', join(directory, 'required-checks.json'), '--task-id', task.id, '--events', join(directory, 'events.jsonl'),
    '--result', join(directory, 'result.json'), '--harness', native ? 'cline' : 'blame', '--max-iterations', String(protocol.budgets.maxIterations), '--timeout-seconds', String(protocol.budgets.timeoutSeconds)];
  const isolated = await json(join(directory,'environment.json'));
  const env = { ...process.env, ...isolated.env, PATH: join(directory,'workspace/node_modules/.bin')+':'+process.env.PATH, NODE_PATH:'', NODE_USE_ENV_PROXY: '1', BLAME_HEADLESS_DEV: 'true', NODE_ENV: 'development', TZ: 'UTC',
    BLAME_STUDY_DATE_BINDING: join(study, 'prompt-date-binding.json'), BLAME_STUDY_DATE_AUDIT: join(directory, 'date-loads.jsonl'),
    BLAME_STUDY_NATIVE_SEARCH_BINDINGS: join(study, 'native-search-bindings.json'), BLAME_STUDY_NATIVE_SEARCH_AUDIT: join(directory, 'search-loads.jsonl'),
    BLAME_STUDY_WIRE_AUDIT: join(directory, 'wire-contracts.jsonl'), BLAME_STUDY_WORKSPACE: join(directory, 'workspace'),
    BLAME_STUDY_REQUEST_MAX_BYTES: String(protocol.budgets.maximumSerializedRequestBytes), BLAME_AGENT_REQUEST_MAX_OUTPUT_TOKENS: '8192', BLAME_AGENT_MAX_SESSION_COST_USD: String(protocol.budgets.perTrialSdkCostLimitUsd) };
  return new Promise((done, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [...imports, ...args], { cwd: repo, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', watchdog = false;
    child.stderr.on('data', chunk => { if (stderr.length < 16384) stderr += chunk.toString(); });
    const timer = setTimeout(() => { watchdog = true; process.kill(-child.pid, 'SIGKILL'); }, (protocol.budgets.timeoutSeconds + protocol.budgets.outerWatchdogExtraSeconds) * 1000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal, watchdog, durationMs: performance.now() - started,
      stderr: stderr.replaceAll(process.env.BLAME_API_TOKEN, '[REDACTED]') }); });
  });
}
async function lines(path) {
  return readFile(path, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(JSON.parse), error => { if (error.code === 'ENOENT') return []; throw error; });
}
export async function analyse(slot, directory, exit, grade) {
  const events = (await lines(join(directory, 'events.jsonl'))).map(row => row.event);
  const result = await json(join(directory, 'result.json')).catch(() => ({}));
  const wire = await lines(join(directory, 'wire-contracts.jsonl'));
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
  const finishFailures=tools.filter(tool=>tool.tool==='finish_task'&&tool.output?.status!=='ok');
  const compilerScopeObservations=[];
  for(const [index,t]of tools.entries()){
    if(t.tool!=='run_task')continue;
    const report=t.output?.data?.validation?.compilerScope??t.output?.data?.completed?.data?.validation?.compilerScope;
    if(!report)continue;
    const follow=tools.findIndex((next,j)=>j>index&&next.observedIteration>t.observedIteration&&next.tool==='run_task'&&/delivered/.test(JSON.stringify(next.input)));
    compilerScopeObservations.push({index,observedIteration:t.observedIteration,report,followedValidationIndex:follow<0?null:follow});
  }
  const forwarded = wire.filter(request => !request.budgetRejected);
  const contractPassed = forwarded.every(request => request.maximumOutputTokens === 8192 && request.model === protocol.model && request.reasoning?.effort === protocol.effort)
    && usage.perRequest.every(report => report.output === null || report.output <= 8192) && !(usage.reports > 0 && forwarded.length === 0);
  await save(join(directory, 'tool-ledger.json'), tools);
  const row = { ...slot, name: `${slot.repeat}-${slot.task}-${slot.arm}`, officialRuntimeSuccess: result.status === 'succeeded', status: result.status ?? 'missing',
    selectedCheckSuccess: grade.protectedPaths.length===0&&grade.checks.filter(c=>c.name!=='feature').every(c=>c.exitCode===0)&&grade.deliveredChecks.find(c=>c.name==='delivered')?.exitCode===0,
    independentFunctionalSuccess: grade.independentFunctionalSuccess, auditedCompletion: null, durationMs: result.durationMs ?? exit.durationMs,
    usage, metrics: result.metrics ?? null, completion: result.completion ?? null, error: result.error ?? null, exit,
    selectionFailures, noTestFileOutputs:noTestFileOutputs.length, finishFailures:finishFailures.length,
    compilerScopeObservations, scopeFeedbackOffered:compilerScopeObservations.filter(o=>o.report.status==='reported'&&o.report.changedFilesNotReported.length>0).length,
    scopeFeedbackFollowed:compilerScopeObservations.filter(o=>o.report.status==='reported'&&o.report.changedFilesNotReported.length>0&&o.followedValidationIndex!==null).length,
    pathRecoveryOffered: recoveryOffers.length, pathRecoveryFollowed: new Set(recoveryOffers.map(r=>r.followedReadIndex).filter(i=>i!==null)).size, pathRecoveryDirectlyFollowed: recoveryOffers.filter(r=>r.directNextNavigation).length, recoveryOffers,
    declarationCalls: tools.filter(tool => tool.tool === 'read_code' && tool.input?.view === 'declaration').length,
    successfulDeclarationCalls: tools.filter(tool => tool.tool === 'read_code' && tool.output?.status === 'ok' && tool.output?.data?.view === 'declaration').length,
    blockedEdits: tools.filter(tool => tool.tool === 'edit_code' && tool.output?.status !== 'ok').length,
    contract: { passed: contractPassed, forwarded: forwarded.length, usageReports: usage.reports, unreported: Math.max(0, forwarded.length - usage.reports) },
    hashes: Object.fromEntries(await Promise.all(['events.jsonl', 'workspace.diff', 'score.json', 'tool-ledger.json'].map(async path =>
      [path, await readFile(join(directory, path)).then(sha, () => null)]))) };
  return { row, wire };
}
async function run() {
  await verifyBindings();
  const protocolPath = relative(repo, join(study, 'protocol.json'));
  assert.equal(git(['show', `HEAD:${protocolPath}`], repo), await readFile(join(study, 'protocol.json'), 'utf8'), 'Protocol must be committed before model launch');
  await mkdir(campaign); const rows = [], wireByTrial = {};
  await save(join(campaign, 'provenance.json'), { protocolSha256: sha(await readFile(join(study, 'protocol.json'))), startedAtUTC: new Date().toISOString(), order: protocol.order });
  const prior = await json(join(study, 'prior-budget.json')); let accounting = reserveTrialCosts(rows, wireByTrial, protocol.budgets);
  for (const slot of protocol.order) {
    if (await readFile(join(work, 'pause-before-next-trial')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
      await save(join(campaign, 'administrative-pause.json'), { nextSlot: slot, modelRetried: false }); break;
    }
    const reserve = protocol.budgets.perTrialSdkCostLimitUsd + protocol.budgets.requestOvershootReserveUsd;
    if (accounting.accountedUsd + reserve > protocol.budgets.panelObservedCostStopUsd || prior.accountedUsd + accounting.accountedUsd + reserve > protocol.budgets.sharedStudyObservedCostStopUsd) {
      await save(join(campaign, 'budget-stop.json'), { slot, accounting, prior, reserve }); break;
    }
    await verifyBindings(); const task = protocol.tasks.find(task => task.id === slot.task);
    const name = `${slot.repeat}-${slot.task}-${slot.arm}`, directory = join(campaign, name); await mkdir(directory);
    await prepare(join(directory, 'workspace'), task.id, true); await writeFile(join(directory, 'instruction.txt'), task.instruction);
    await save(join(directory, 'required-checks.json'), task.requiredChecks);
    console.log('START', name); await save(join(directory, 'model-start.json'), { slot, startedAtUTC: new Date().toISOString() });
    const exit = await execute(directory, slot, task); await save(join(directory, 'model-exit.json'), exit);
    const grade = await score(directory, task.id);
    const environment = await json(join(directory,'environment.json'));
    grade.dependencyIntegrity = compareDependencyManifests(environment.manifest,await dependencyManifest(join(directory,'workspace/node_modules')));
    await save(join(directory, 'score.json'), grade);
    const { row, wire } = await analyse(slot, directory, exit, grade); rows.push(row); wireByTrial[name] = wire;
    await save(join(campaign, 'analysis.json'), { planned: protocol.order.length, rows });
    accounting = reserveTrialCosts(rows, wireByTrial, protocol.budgets); await save(join(campaign, 'accounting.json'), accounting);
    // Preserve exact worker files privately; publish diffs/traces and replay from pinned inputs.
    // Release extracted fixture inodes only after a successful archive and grade.
    execFileSync('tar', ['-czf', join(directory, 'workspace.tar.gz'), '--exclude=workspace/node_modules', '-C', directory, 'workspace']);
    await save(join(directory, 'workspace-archive.json'), { sha256: sha(await readFile(join(directory, 'workspace.tar.gz'))), includesJournal: true });
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
else if (process.argv[2] === 'run') await run();
