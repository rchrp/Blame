// Known diagnostic controls only; no model calls or representative task-success claims.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const repo=resolve(import.meta.dirname,'../../..'),study=join(repo,'docs/experiments/light-harness-followup-f51-2026-10-18');
const output=process.argv[2];assert.ok(output,'Explicit new output path required');
await access(output).then(()=>{throw Error('Refuse overwrite');},e=>{if(e.code!=='ENOENT')throw e;});
const sha=x=>createHash('sha256').update(x).digest('hex');
const modules={reference:'/tmp/blame-symbolic-model-f50/frozen/current/agent-runtime/dist/harness',candidate:join(repo,'packages/agent-runtime/dist/harness')};
const dependencies=join(repo,'.blame/research/validation-scope-f44/dependencies'),rows=[];
const root=await mkdtemp('/tmp/blame-f51-local-');
try{
 for(const mode of ['passing','masked_failure','stale','type_error','empty','unsupported_reporter'])for(const arm of ['reference','candidate']){
  const path=join(root,mode+'-'+arm);await mkdir(path);
  await symlink(join(dependencies,'node_modules'),join(path,'node_modules'));
  await writeFile(join(path,'.gitignore'),'.blame/\nnode_modules/\n');
  await writeFile(join(path,'package.json'),JSON.stringify({type:'module',scripts:{'test:wrapped':'node wrapper.mjs'}}));
  const source=`import {test,expect} from 'vitest'; ${mode==='type_error'?'const invalid:number="text";':''}test('actual',()=>expect(1).toBe(${mode==='masked_failure'?2:1}));\n`;
  await writeFile(join(path,'case.test.ts'),source);
  const args=['node_modules/vitest/vitest.mjs','run',mode==='empty'?'absent.test.ts':'case.test.ts','--maxWorkers=1','--fileParallelism=false',...(mode==='unsupported_reporter'?['--reporter=dot']:[])];
  await writeFile(join(path,'wrapper.mjs'),`import {spawnSync} from 'node:child_process';import {writeFileSync} from 'node:fs';spawnSync(process.execPath,${JSON.stringify(args)},{stdio:'inherit'});${mode==='stale'?`writeFileSync('case.test.ts',${JSON.stringify(source+'// later revision\n')});`:''}process.exitCode=0;\n`);
  const {LightWorkspace}=await import(pathToFileURL(join(modules[arm],'light-workspace.js')));
  const workspace=new LightWorkspace(path,{sessionId:mode+'-'+arm});
  const result=await workspace.runTask({kind:'project',task:'test:wrapped'},{});
  assert.equal(result.status,'ok');const check=result.data.check;
  const checks=await workspace.readCode({target:'@checks'},{});
  const row={mode,arm,result,checks,sourceSha256Before:sha(source),sourceSha256After:sha(await readFile(join(path,'case.test.ts')))};
  console.log(JSON.stringify({mode,arm,check}));
  if(arm==='candidate'){
   if(['passing','type_error','stale','masked_failure'].includes(mode)){
    assert.equal(check.evidenceOrigin,'vitest_report');assert.equal(check.counts.executed,1);
    assert.equal(check.outcome,mode==='masked_failure'?'failed':'passed');
    assert.equal(check.evidence.invocations[0].files[0].unchanged,mode!=='stale');
    assert.equal(check.evidence.typeFileSelection,'unknown');
   }else assert.equal(check.outcome,'unknown');
   if(mode==='stale')assert.equal(check.freshness,'stale');
  }else assert.equal(check.outcome,'unknown');
  assert.equal(result.data.reporting.admission,'unverified');
  if(mode==='type_error'){
   const t=spawnSync(process.execPath,[join(dependencies,'node_modules/typescript/bin/tsc'),'--noEmit','--skipLibCheck','--moduleResolution','bundler','--module','esnext','--target','es2022','case.test.ts'],{cwd:path,encoding:'utf8',timeout:30000});
   assert.equal(t.status,2);assert.match(t.stdout,/TS2322/);row.independentTypes={exitCode:t.status,output:t.stdout};
  }
  rows.push(row);await rm(path,{recursive:true,force:true});
 }
 const coverage=[];
 const requests=JSON.parse(await readFile(join(repo,'docs/experiments/light-harness-symbolic-model-f50-2026-10-18/endpoint-symbolic-protocol.json'),'utf8')).requests;
 for(const arm of ['reference','candidate']){
  const {analyzeSymbolicSource}=await import(pathToFileURL(join(modules[arm],'symbolic-analysis.js')));
  const cases=[{source:'function availableCredit(balance:number,reserved:number,limit:number){return Math.max(0,Math.max(0,limit)-Math.max(0,balance)-Math.max(0,reserved));}',id:'availableCredit'},
   {source:'function lowerTierUnits(first:number,last:number,boundary:number){return first>last?0:Math.max(0,Math.min(last,boundary)-first+1);}',id:'lowerTierUnits'},
   {source:'function tierCost(lowerUnits:number,upperUnits:number,lowerRate:number,upperRate:number){return lowerUnits*Math.max(0,lowerRate)+upperUnits*Math.max(0,upperRate);}',id:'tierCost'}];
  for(const c of cases){const r=requests.find(r=>r.id===c.id);const result=await analyzeSymbolicSource({source:c.source,functionName:c.id,inputs:r.input.inputs,assertion:r.input.assertion,solverPath:'/tmp/blame-z3-f46/bin/z3'});
   assert.equal(result.status,arm==='reference'?'unknown':'bounded_no_counterexample');coverage.push({arm,id:c.id,source:c.source,result});}
 }
 const bindings={};for(const [arm,dir]of Object.entries(modules)){bindings[arm]={};for(const name of ['light-workspace','light-task-runner','check-observation','symbolic-expression','symbolic-program','symbolic-analysis'])bindings[arm][name]=sha(await readFile(join(dir,name+'.js')));}
 await mkdir(study,{recursive:true});await writeFile(output,JSON.stringify({kind:'known_local_controls',modelCalls:0,bindings,rows,coverage,limitations:'Constructed known controls. No broad scope/type admission or model benefit. Local runs may overlap unit verification; no timing comparison.'},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({output,controls:rows.length,intrinsicComparisons:coverage.length,modelCalls:0}));
}finally{await rm(root,{recursive:true,force:true});}
