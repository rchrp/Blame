import assert from 'node:assert/strict';
import {mkdir,rm,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {repo,work,study,prepare,json,save} from './setup.mjs';
import {solverIdentity} from './solver-identity.mjs';
const startedAtUTC=new Date().toISOString(),root=join(work,'environment-smoke/workspace');
await mkdir(join(root,'..'),{recursive:true});await prepare(root,'suffix-counts',true);
const environment=await json(join(root,'../environment.json'));
const solver=await solverIdentity(process.env.BLAME_Z3_PATH??'/tmp/blame-z3-f46/bin/z3');
const env={...process.env,...environment.env,NODE_PATH:'',BLAME_Z3_PATH:solver.path};
const version=spawnSync('npm',['--version'],{cwd:root,env,encoding:'utf8'});
const shell=spawnSync('/bin/bash',['-lc','command -v npm && npm --version'],{cwd:root,env,encoding:'utf8'});
const before=spawnSync('/bin/bash',['-lc','command -v npm && npm --version'],{cwd:root,env:{...env,BASH_ENV:''},encoding:'utf8'});
const source=`import{LightWorkspace}from${JSON.stringify(join(work,'frozen/current/agent-runtime/dist/harness/light-workspace.js'))};const w=new LightWorkspace(${JSON.stringify(root)},{sessionId:'environment-smoke'});console.log(JSON.stringify(await w.runTask({kind:'command',command:'npm --version'},{})));`;
const harness=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:root,env,encoding:'utf8',timeout:30000});
const result=JSON.parse(harness.stdout);assert.equal(version.status,0);assert.equal(version.stdout.trim(),'11.6.4');
assert.equal(shell.status,0);assert.ok(shell.stdout.includes('11.6.4'));assert.equal(harness.status,0);assert.equal(result.status,'ok');assert.equal(result.data.output.trim(),'11.6.4');
const core=join(dirname(await realpath(join(repo,'packages/agent-runtime/node_modules/@cline/sdk'))),'core/dist/index.js');
const nativeSource=`import{createShellExecutor}from${JSON.stringify(core)};const run=createShellExecutor({timeoutMs:10000});console.log(JSON.stringify(await run('npm --version',${JSON.stringify(root)},{signal:new AbortController().signal})));`;
const native=spawnSync(process.execPath,['--input-type=module','-e',nativeSource],{cwd:root,env,encoding:'utf8',timeout:30000});
assert.equal(native.status,0,native.stderr);assert.match(native.stdout,/11\.6\.4/);
await save(join(study,'environment-smoke.json'),{startedAtUTC,endedAtUTC:new Date().toISOString(),modelRequests:0,solver,shellEnvironmentSha256:environment.shellEnvironmentSha256,
 method:'Actual Light and integrated SDK executors plus direct/login npm11.6.4 checks in copied isolated dependencies. No solver query or model call in this navigation smoke.',
 before:{exitCode:before.status,stdout:before.stdout,stderr:before.stderr},version:{exitCode:version.status,stdout:version.stdout},shell:{exitCode:shell.status,stdout:shell.stdout},harness:{exitCode:harness.status,result},native:{exitCode:native.status,stdout:native.stdout,stderr:native.stderr}});
await rm(join(root,'..'),{recursive:true});console.log('Pinned npm11.6.4 preserved through direct, login-shell, Light and integrated SDK command execution');
