// Deterministic mechanism replay, not a model, token or latency benchmark.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {atomicJson} from '../durable-campaign.mjs';

const repo=resolve(import.meta.dirname,'../../..'), work='/workspace/blame-study-runs/harness-feedback-f57';
const study=join(repo,'docs/experiments/light-harness-feedback-f57-2026-10-18');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const stages={baseline:join(work,'baseline/dist/harness'),navigation:join(work,'navigation/dist/harness'),
  body:join(work,'body/dist/harness'),repair:join(repo,'packages/agent-runtime/dist/harness')};
const runtime=async stage=>({...(await import(pathToFileURL(join(stages[stage],'light-workspace.js')))),
  ...(await import(pathToFileURL(join(stages[stage],'light-finish-service.js'))))});
const ok=result=>{assert.equal(result.status,'ok',JSON.stringify(result));return result.data;};
const observations=[];
async function fixture(name,files,run){
  const root=join(work,'local',name);await mkdir(root,{recursive:true});
  for(const [path,content]of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),content);}
  try{return await run(root);}finally{await rm(root,{recursive:true});}
}
for(const stage of ['baseline','navigation']){
  const {LightWorkspace}=await runtime(stage);
  for(const mode of [undefined,'text']){
    const files=Object.fromEntries(Array.from({length:12},(_,i)=>[`a${String(i).padStart(2,'0')}.ts`,`export const caller${i}=()=>needle(${i});\n`]));
    files['z.ts']='export function needle(n:number){return n+1;}\n';
    await fixture(`navigation-${stage}-${mode??'default'}`,files,async root=>{
      const workspace=new LightWorkspace(root,{sessionId:'replay'}),search=await workspace.searchCode({query:'needle',...(mode?{mode}:{})});
      const data=ok(search), offered=data.declarationCandidates?.find(d=>d.path==='z.ts');
      let followup=null, calls=1;
      if(offered)followup=await workspace.readCode({target:offered.target,view:'symbol'},{});
      else {followup=await workspace.searchCode({query:'needle',mode:'symbol',scope:'z.ts'});calls++;followup=await workspace.readCode({target:ok(followup).results[0].alias,view:'symbol'},{});}
      calls++;assert.match(JSON.stringify(followup),/return n/u);
      observations.push({mechanism:'navigation',stage,mode:mode??'default',offered:!!offered,calls,search,followup});
    });
  }
}
for(const stage of ['navigation','body']){
  const {LightWorkspace}=await runtime(stage);
  const source='export function clamp(value:number,{min,max}:{min:number;max:number}):number { return value; }\n';
  await fixture(`body-${stage}`,{'value.ts':source},async root=>{
    const workspace=new LightWorkspace(root,{sessionId:'replay'});ok(await workspace.readCode({target:'value.ts#clamp'},{}));
    const receipt=await workspace.editCode({operations:[{kind:'symbol',target:'value.ts#clamp',action:'replace_body',content:'return Math.min(max, Math.max(min,value));'}]});
    const data=ok(receipt),content=await readFile(join(root,'value.ts'),'utf8');
    assert.ok(content.startsWith(source.slice(0,source.indexOf(' { return'))));
    assert.equal(!!data.bodyEditContext,stage==='body');
    observations.push({mechanism:'body-header',stage,receipt,receiptBytes:Buffer.byteLength(JSON.stringify(receipt)),sourceHash:sha(content),headerShown:!!data.bodyEditContext});
  });
}
for(const stage of ['body','repair']){
  const {LightWorkspace,LightFinishService}=await runtime(stage),alpha=['--test-name-pattern=alpha','suite.test.cjs'],beta=['--test-name-pattern=beta','suite.test.cjs'];
  const required_checks=[{id:'build',task:'build'},{id:'alpha',task:'test',args:alpha},{id:'beta',task:'test',args:beta}];
  await fixture(`repair-${stage}`,{
    'package.json':JSON.stringify({scripts:{test:'node --test',build:'node --check value.cjs'}}),
    'value.cjs':'exports.value = 1;\n',
    'suite.test.cjs':"const{test}=require('node:test');const assert=require('node:assert/strict');const{value}=require('./value.cjs');test('alpha',()=>assert.equal(value,2));test('beta',()=>assert.ok(value<4));\n",
  },async root=>{
    const workspace=new LightWorkspace(root,{sessionId:'replay',taskContract:{required_checks}}),outputs=[];
    for(const input of [{kind:'project',task:'test',args:alpha},{kind:'project',task:'test',args:beta},{kind:'project',task:'build'}])outputs.push(await workspace.runTask(input,{}));
    const edit=async(before,after)=>ok(await workspace.editCode({operations:[{kind:'patch',path:'value.cjs',patch:`*** Begin Patch\n*** Update File: value.cjs\n@@\n-exports.value = ${before};\n+exports.value = ${after};\n*** End Patch`}]}));
    const firstEdit=await edit(1,3),started=[],notifications=[];
    const service=new LightFinishService({workspaceRoot:root,conversationId:'replay',taskContract:{required_checks},onValidationActivity:a=>{if(a.phase==='started')started.push(a.input);},onComplete:n=>{notifications.push(n);}});
    let failure;try{await service.finish('still broken',{});}catch(error){failure=error.message;}
    assert.match(failure,/still failing/);assert.equal(notifications.length,0);
    const failedFinishInvocations=[...started];await edit(3,2);started.length=0;await service.finish('Final source validated; acceptance remains separate.',{});
    assert.equal(started.length,3);assert.equal(notifications[0].verified,true);
    observations.push({mechanism:'repair-order',stage,firstEdit,outputs,failedFinishInvocations,failure,finalInvocations:[...started],completion:notifications[0].completion});
  });
}
const nav=observations.filter(r=>r.mechanism==='navigation');assert.equal(nav.filter(r=>r.offered).length,2);
assert.deepEqual(nav.map(r=>r.calls),[3,3,2,2]);
const repair=observations.filter(r=>r.mechanism==='repair-order');
assert.deepEqual(repair.map(r=>r.failedFinishInvocations.length),[3,1]);
const body=observations.filter(r=>r.mechanism==='body-header');assert.equal(body[0].sourceHash,body[1].sourceHash);
const files={};for(const [stage,root]of Object.entries(stages))for(const name of ['light-workspace','light-reference-search','light-reference-candidates','light-edit','light-finish-service'])files[`${stage}/${name}.js`]=sha(await readFile(join(root,name+'.js')));
await atomicJson(join(study,'local-replay.json'),{phase:'F57',sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),modelRequests:0,files,observations,
  navigation:{constructedCases:2,baselineCalls:6,candidateCalls:4,limitation:'Scripted route selection on saturated cross-file cases, not observed agent adoption or token savings.'},
  body:{identicalSource:true,baselineReceiptBytes:body[0].receiptBytes,candidateReceiptBytes:body[1].receiptBytes,limitation:'More feedback bytes; prevention/recovery is not established without agent behavior.'},
  repair:{failedRefreshInvocationsBefore:3,failedRefreshInvocationsAfter:1,finalInvocationsInBoth:3,limitation:'Avoids two checks while this constructed failure persists; final required checks remain unchanged. Not a global latency benchmark.'}});
console.log('F57: navigation 6→4 scripted calls; failed finish 3→1 invocations; final requirements 3 in both; body feedback adds bytes.');
