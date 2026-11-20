import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionJournal } from "./session-journal.js";
import type { LightCompletionNotification } from "./test-client/light-finish-service.js";
import { LightFinishService } from "./test-client/light-finish-service.js";
import { LightWorkspace } from "./test-client/light-workspace.js";

async function fixture(run: (root: string, tasks: LightWorkspace["tasks"], journal: SessionJournal) => Promise<void>, script="node --test") {
  const root=await mkdtemp(join(tmpdir(),"blame-npm-observation-"));
  try{
    await writeFile(join(root,"package.json"),JSON.stringify({scripts:{test:script}}));
    await writeFile(join(root,"suite.test.cjs"),"require('node:test').test('actual case',()=>{});\n");
    const journal=new SessionJournal(root,"npm-observation");
    await run(root,new LightWorkspace(root,{sessionId:"npm-observation"}).tasks,journal);
  }finally{await rm(root,{recursive:true,force:true});}
}
test("literal raw npm wrapper retains original command and confirms reported Node cases only",async()=>{
  await fixture(async(root,tasks,journal)=>{
    const command="npm test -- suite.test.cjs";
    const result=await tasks.run({kind:"command",command},{});assert.equal(result.status,"ok");
    const state=await journal.completionSnapshot(),check=state.validations[0];
    assert.equal(check?.command,command);assert.deepEqual(check?.args,["suite.test.cjs"]);
    assert.equal(check?.check?.execution,"observed");assert.equal(check?.check?.counts?.executed,1);
    assert.equal(check?.check?.outcome,"passed");assert.equal(check?.status,"unknown");
    assert.equal(check?.check?.selection,"unknown");assert.equal(check?.check?.freshness,"unknown");
    const notifications:LightCompletionNotification[]=[];
    const service=new LightFinishService({workspaceRoot:root,conversationId:"npm-observation",
      taskContract:{required_checks:[{id:"selected",task:"test",args:["suite.test.cjs"]}]},onComplete:n=>{notifications.push(n);}});
    await service.finish("checked",{} as never);
    assert.deepEqual(notifications[0]?.completion.satisfied_obligations,["check:selected"]);
    assert.equal(notifications[0]?.verified,false);
  });
});
test("raw npm runner identity cannot count an empty file worker as a test",async()=>{
  await fixture(async(root,tasks,journal)=>{
    await writeFile(join(root,"empty.test.cjs"),"// Empty.\n");
    await tasks.run({kind:"command",command:"npm test -- empty.test.cjs"},{});
    const state=await journal.completionSnapshot();
    assert.equal(state.validations[0]?.check?.execution,"not_observed");
    assert.equal(state.validations[0]?.check?.counts,undefined);
  });
});
test("unmatched compound npm commands cannot borrow a catalog reporter",async()=>{
  await fixture(async(_root,tasks,journal)=>{
    await tasks.run({kind:"command",command:"npm test -- suite.test.cjs && true"},{});
    const state=await journal.completionSnapshot();
    assert.equal(state.validations[0]?.taskId,undefined);
    assert.equal(state.validations[0]?.check,undefined);
  });
});
test("a catalog script with no recognized runner cannot invent execution",async()=>{
  await fixture(async(_root,tasks,journal)=>{
    await tasks.run({kind:"command",command:"npm test -- suite.test.cjs"},{});
    const state=await journal.completionSnapshot();
    assert.equal(state.validations[0]?.check?.execution,"not_observed");
    assert.equal(state.validations[0]?.check?.outcome,"unknown");
  },"node -e 'process.exit(0)'");
});
test("a real failing raw npm test remains code failure with exact invocation",async()=>{
  await fixture(async(root,tasks,journal)=>{
    await writeFile(join(root,"suite.test.cjs"),"require('node:test').test('actual case',()=>{throw Error('failure')});\n");
    await tasks.run({kind:"command",command:"npm test -- suite.test.cjs"},{});
    const state=await journal.completionSnapshot();
    assert.equal(state.validations[0]?.check?.outcome,"failed");
    assert.equal(state.validations[0]?.check?.counts?.failed,1);
    assert.equal(state.validations[0]?.category,"code");
  });
});
