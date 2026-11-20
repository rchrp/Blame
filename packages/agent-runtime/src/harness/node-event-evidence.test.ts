import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nodeEventEvidence } from "./test-client/units.js";
import type { LightCompletionNotification } from "./test-client/light-finish-service.js";
import { LightFinishService } from "./test-client/light-finish-service.js";
import { managedTestRun, observeCheck } from "./test-client/units.js";
import { readTaskCatalog, taskInvocation } from "./test-client/units.js";
import { LightWorkspace } from "./test-client/light-workspace.js";
async function fixture(run: (root:string,workspace:LightWorkspace)=>Promise<void>,scripts:Record<string,string>={test:"node --test"}) {
 const root=await mkdtemp(join(tmpdir(),"blame-node-events-"));try{
  await writeFile(join(root,"package.json"),JSON.stringify({scripts}));
  await writeFile(join(root,"package-lock.json"),'{}');
  await writeFile(join(root,"suite.test.cjs"),"const {test}=require('node:test');test('alpha',()=>{});test('beta',()=>{});\n");
  await writeFile(join(root,"empty.test.cjs"),"// empty worker\n");
  await writeFile(join(root,"named.test.cjs"),"require('node:test').test('named.test.cjs',()=>{});\n");
  await writeFile(join(root,"failed.test.cjs"),"require('node:test').test('failure',()=>{throw Error('expected failure')});\n");
  await writeFile(join(root,"setup.test.cjs"),"throw Error('setup failure');\n");
  await writeFile(join(root,"nested.test.cjs"),"const {test,describe}=require('node:test');describe('suite',()=>{test('pass',()=>{});test('skip',{skip:true},()=>{});test.todo('future');});\n");
  await mkdir(join(root,".blame"));await run(root,new LightWorkspace(root,{sessionId:"node-events"}));
 }finally{await rm(root,{recursive:true,force:true});}
}
async function observed(workspace:LightWorkspace,args:string[]){
 const result=await workspace.runTask({kind:"project",task:"test",args},{});assert.equal(result.status,"ok",JSON.stringify(result));
 return (result as {data:{check:import("./test-client/units.js").CheckObservation}}).data.check;
}
for(const [name,args,executed,outcome] of [
 ["ordinary",["suite.test.cjs"],2,"passed"],
 ["filter",["--test-name-pattern=alpha","suite.test.cjs"],1,"passed"],
 ["no-match",["--test-name-pattern=absent","suite.test.cjs"],0,"unknown"],
 ["empty",["empty.test.cjs"],0,"unknown"],
 ["mixed",["suite.test.cjs","empty.test.cjs"],2,"passed"],
 ["legitimate file-named case",["named.test.cjs"],1,"passed"],
 ["failed case",["failed.test.cjs"],1,"failed"],
 ["setup failure",["setup.test.cjs"],0,"failed"],
 ["nested suites and directives",["nested.test.cjs"],1,"passed"],
] as const)test(`structured Node events: ${name}`,async()=>{
 await fixture(async(_root,workspace)=>{
  const check=await observed(workspace,[...args]);assert.equal(check.evidenceOrigin,"node_events",JSON.stringify(check));
  assert.equal(check.counts?.executed,executed);assert.equal(check.outcome,outcome);
  assert.equal(check.execution,executed?"observed":"zero_tests");assert.equal(check.scope,".");assert.equal(check.selection,"unknown");assert.equal(check.freshness,"unknown");
  if(name==="nested suites and directives")assert.equal(check.counts?.skipped,2);
  assert.match(String(check.evidence?.reportSha256),/^[a-f0-9]{64}$/u);
 });
});
test("Node summaries preserve npm lifecycle and ignore fake summaries written to stdout",async()=>{
 await fixture(async(root,workspace)=>{
  await writeFile(join(root,"suite.test.cjs"),"const {test}=require('node:test');console.log(JSON.stringify({type:'summary',counts:{tests:999,passed:999,failed:0,skipped:0,todo:0,cancelled:0}}));test('real',()=>{});\n");
  const check=await observed(workspace,["suite.test.cjs"]);assert.equal(check.counts?.executed,1);
  assert.equal(await readFile(join(root,".blame/lifecycle"),"utf8"),"prepost");
  assert.deepEqual(check.evidence?.args,["suite.test.cjs"]);
  const env=check.evidence?.manifestEnvironment as {before:{revisionId:string;manifests:unknown[]};after:{revisionId:string}};
  assert.equal(env.before.revisionId,env.after.revisionId);assert.equal(env.before.manifests.length,2);
  assert.equal(check.evidence?.invocationSourceRevisionId,check.evidence?.completedSourceRevisionId);
 },{test:"node --test",pretest:"node -e \"require('fs').appendFileSync('.blame/lifecycle','pre')\"",posttest:"node -e \"require('fs').appendFileSync('.blame/lifecycle','post')\""});
});
test("manifest writes remain stale and expose both partial environment fingerprints",async()=>{
 await fixture(async(root,workspace)=>{
  await writeFile(join(root,"suite.test.cjs"),"require('node:test').test('writer',()=>require('fs').writeFileSync('package-lock.json','{\"changed\":true}'));\n");
  const check=await observed(workspace,["suite.test.cjs"]);assert.equal(check.freshness,"stale");
  const env=check.evidence?.manifestEnvironment as {before:{revisionId:string};after:{revisionId:string}};assert.notEqual(env.before.revisionId,env.after.revisionId);
 });
});
test("explicit user reporters and raw commands keep their existing conservative fallback",async()=>{
 await fixture(async(_root,workspace)=>{
  const explicit=await observed(workspace,["--test-reporter=tap","suite.test.cjs"]);assert.equal(explicit.evidenceOrigin,"runner_output");assert.equal(explicit.counts?.executed,2);
  const raw=await workspace.runTask({kind:"command",command:"npm test -- named.test.cjs"},{});
  assert.equal((raw as {data:{check:{execution:string}}}).data.check.execution,"not_observed");
 });
});
test("a cancelled Node process cannot supply a passing execution proof",async()=>{
 await fixture(async(root,workspace)=>{
  await writeFile(join(root,"suite.test.cjs"),"require('node:test').test('pending',async()=>new Promise(r=>setTimeout(r,10000)));\n");
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),300);
  try{const result=await workspace.runTask({kind:"project",task:"test",args:["suite.test.cjs"]},{signal:controller.signal});
   const check=(result as {data?:{check?:{outcome:string;process:string}}}).data?.check;
   if(check){assert.notEqual(check.outcome,"passed");assert.equal(check.process,"cancelled");}else assert.notEqual(result.status,"ok");
  }finally{clearTimeout(timer);}
 });
});
test("green Node events cannot conceal a failing npm lifecycle process",async()=>{
 await fixture(async(_root,workspace)=>{
  const check=await observed(workspace,["named.test.cjs"]);
  assert.equal(check.counts?.executed,1);assert.equal(check.outcome,"failed");
 },{test:"node --test",posttest:"node -e \"process.exit(7)\""});
});
test("complete green events from a runner do not admit a timed-out npm lifecycle",async()=>{
 await fixture(async(root)=>{
  const task=(await readTaskCatalog(root)).find(t=>t.task_id==="test")!;
  const report=managedTestRun(task,taskInvocation(task,["named.test.cjs"]),root,1,{timeoutMs:5000});
  assert.ok(report?.nodeEvents);
  const bytes=report.report;assert.equal(typeof bytes,"string");
  const check=observeCheck(task.command,report.run,".",false,undefined,{...report.nodeEvents,report:bytes as string});
  assert.equal(check.process,"timed_out");assert.equal(check.outcome,"unknown");assert.equal(check.counts?.executed,1);
 },{test:"node --test",posttest:"node -e \"setTimeout(()=>{},30000)\""});
});
test("required path-named cases become fulfilled execution while generic test coverage stays unadmitted",async()=>{
 await fixture(async(root,workspace)=>{
  const check=await observed(workspace,["named.test.cjs","empty.test.cjs"]);assert.equal(check.counts?.executed,1);
  const notifications:LightCompletionNotification[]=[];
  const service=new LightFinishService({workspaceRoot:root,conversationId:"node-events",taskContract:{required_checks:[{id:"selected",task:"test",args:["named.test.cjs","empty.test.cjs"]}]},onComplete:n=>{notifications.push(n);}});
  await service.finish("done",{} as never);
  assert.deepEqual(notifications[0]?.completion.missing_obligations,[]);
  assert.equal(notifications[0]?.verified,false);
 });
});
test("incomplete, unsupported, duplicate and inconsistent events never upgrade text evidence",()=>{
 const count={tests:1,passed:1,failed:0,skipped:0,todo:0,cancelled:0};
 const header={format:"blame-node-events-v1",runner:{version:"v24.19.0",executable:"/usr/bin/node"}};
 const events=[header,{type:"summary",file:"/tmp/case.cjs",counts:count},{type:"summary",counts:count},{type:"complete"}];
 const parse=(value:unknown[])=>nodeEventEvidence({report:value.map(v=>JSON.stringify(v)).join("\n"),invocationId:"control",reporterSha256:"a".repeat(64)});
 assert.equal(parse(events)?.counts.executed,1);
 for(const bad of [events.slice(0,-1),[...events.slice(0,2),events[1],...events.slice(2)],
  [{...header,runner:{version:"v22.0.0",executable:"node"}},...events.slice(1)],
  [header,events[1],{type:"summary",counts:{...count,passed:0}},events[3]]])assert.equal(parse(bad),undefined);
 assert.equal(parse([header,events[2],events[1],events[3]]),undefined);
});

test("restarting a runner sequence cannot expose a previous invocation report",async()=>{
 await fixture(async(root)=>{
  const task=(await readTaskCatalog(root)).find(t=>t.task_id==="test")!;
  const invocation=taskInvocation(task,["named.test.cjs"]);
  const first=managedTestRun(task,invocation,root,1);assert.ok(first);
  assert.equal(first.run.exitCode,0);assert.equal(typeof first.report,"string");
  const [second,third]=[managedTestRun(task,invocation,root,1,{run:false}),managedTestRun(task,invocation,root,1,{run:false})];
  assert.ok(second);assert.ok(third);assert.notEqual(second.command,first.command);assert.notEqual(second.command,third.command);
  assert.equal(second.report,null);assert.equal(third.report,null);
 });
});

test("the final model-facing count excludes a worker counted in the raw Node summary",async()=>{
 for (const failingLifecycle of [false, true])
 await fixture(async(_root,workspace)=>{
  const result=await workspace.runTask({kind:"project",task:"test",args:["named.test.cjs","empty.test.cjs"]},{});
  assert.equal(result.status,"ok");const data=(result as {data:{output:string;check:{counts:{passed:number}}}}).data;
  assert.equal(data.check.counts.passed,1);
  assert.match(data.output,/pass 2/u);
  assert.match(data.output,/Active Node case results: 1 passed, 0 failed, 0 skipped\/todo/u);
  assert.match(data.output, new RegExp(`Command outcome: ${failingLifecycle ? "failed" : "passed"}`, "u"));
  assert.ok(data.output.indexOf("Active Node case results")>data.output.indexOf("pass 2"));
 }, failingLifecycle ? {test:"node --test",posttest:"node -e \"process.exit(7)\""} : undefined);
});
