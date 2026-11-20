import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { observeCheck } from "./test-client/units.js";
import { LightWorkspace } from "./test-client/light-workspace.js";
import { LightFinishService, type LightCompletionNotification } from "./test-client/light-finish-service.js";
import { workspaceCommandEnvironment } from "./workspace-command-environment.js";

const observe = observeCheck;

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "blame-node-observation-"));
  try {
    await writeFile(join(root,"suite.test.cjs"), "const {test}=require('node:test');test('alpha',()=>{});test('beta',()=>{});\n");
    await writeFile(join(root,"empty.test.cjs"), "// No registered cases.\n");
    await writeFile(join(root,"named.test.cjs"), "require('node:test').test('named.test.cjs',()=>{});\n");
    await writeFile(join(root,"fail.test.cjs"), "throw Error('setup failed');\n");
    await run(root);
  } finally { await rm(root,{recursive:true,force:true}); }
}
function check(root: string, args: string[]) {
  const argv = ["--test",...args];
  const result = spawnSync(process.execPath,argv,{cwd:root,encoding:"utf8",timeout:5000,
    env:workspaceCommandEnvironment(process.env,process.execPath)});
  assert.equal(result.error,undefined);
  return observe("node " + argv.join(" "), {
    all:result.stdout+result.stderr,
    exitCode:result.status ?? undefined,failed:result.status!==0,
  }, ".",false);
}
for (const reporter of [[],["--test-reporter=tap"]]) {
  const name = reporter.length ? "TAP" : "default";
  test(`${name}: a no-match filter and empty file do not prove executed test cases`, async () => {
    await fixture(async root => {
      for (const args of [["--test-name-pattern=absent","suite.test.cjs"],["empty.test.cjs"]]) {
        const observation=check(root,[...reporter,...args]);
        assert.equal(observation.execution,"not_observed");assert.equal(observation.outcome,"unknown");
        assert.equal(observation.counts,undefined);assert.equal(observation.selection,"unknown");
      }
    });
  });
  test(`${name}: mixed file workers cannot inflate the case count`,async()=>{
    await fixture(async root=>{
      const observation=check(root,[...reporter,"suite.test.cjs","empty.test.cjs"]);
      assert.equal(observation.execution,"not_observed");assert.equal(observation.counts,undefined);
    });
  });
  test(`${name}: genuine cases and exact filters retain observed counts`,async()=>{
    await fixture(async root=>{
      for(const [args,count] of [[["suite.test.cjs"],2],[["--test-name-pattern=alpha","suite.test.cjs"],1]] as const){
        const observation=check(root,[...reporter,...args]);
        assert.equal(observation.execution,"observed");assert.equal(observation.outcome,"passed");
        assert.equal(observation.counts?.executed,count);assert.equal(observation.freshness,"unknown");
      }
    });
  });
  test(`${name}: ambiguous legitimate path-named cases conservatively lose confirmation`,async()=>{
    await fixture(async root=>{
      const observation=check(root,[...reporter,"named.test.cjs"]);
      assert.equal(observation.execution,"not_observed");assert.equal(observation.outcome,"unknown");
    });
  });
  test(`${name}: setup failures remain failures even without case counts`,async()=>{
    await fixture(async root=>{
      const observation=check(root,[...reporter,"fail.test.cjs"]);
      assert.equal(observation.outcome,"failed");assert.equal(observation.counts,undefined);
    });
  });
}

for(const args of [["--test-name-pattern=absent","suite.test.cjs"],["empty.test.cjs"]])
  test(`an ambiguous Node result cannot fulfill the required check ${args.join(" ")}`,async()=>{
    await fixture(async root=>{
      await writeFile(join(root,"package.json"),JSON.stringify({scripts:{test:"node --test",build:"node --check value.cjs"}}));
      await writeFile(join(root,"value.cjs"),"exports.value=1;\n");
      const workspace=new LightWorkspace(root,{sessionId:"node-control"});
      assert.equal((await workspace.editCode({operations:[{kind:"patch",path:"value.cjs",patch:"*** Begin Patch\n*** Update File: value.cjs\n@@\n-exports.value=1;\n+exports.value=2;\n*** End Patch"}]})).status,"ok");
      await workspace.runTask({kind:"project",task:"build"},{});
      const notifications:LightCompletionNotification[]=[];
      const service=new LightFinishService({workspaceRoot:root,conversationId:"node-control",
        taskContract:{required_checks:[{id:"selected",task:"test",args}]},
        onComplete:n=>{notifications.push(n);}});
      await service.finish("done",{} as never);
      assert.equal(notifications[0]?.verified,false);
      assert.deepEqual(notifications[0]?.completion.missing_obligations,["check:selected"]);
    });
  });
