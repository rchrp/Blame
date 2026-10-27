import test from 'node:test';import assert from 'node:assert/strict';import {requiredEvidence} from './required-evidence.mjs';
const checks=[{id:'a',task:'test:a'},{id:'b',task:'test:b'}],root='/frozen/workspace';
const epochs=id=>['started','finished'].map(phase=>({phase,callId:id,epoch:{sha256:'final'}}));
test('native and Light use literal child success and final source, independently of formal admission',()=>{
 const tools=[{tool:'run_task',toolCallId:'a',input:{kind:'project'},output:{status:'ok',data:{command:'npm run test:a',exitCode:0,reporting:{admission:'unverified'}}}},
 {tool:'run_commands',toolCallId:'b',output:[{query:'cd '+root+' && npm run test:b',success:true,result:'passed'}]}];
 assert.deepEqual(requiredEvidence(tools,[...epochs('a'),...epochs('b')],'final',checks,root).map(e=>e.passedOnFinalSource),[true,true]);
});
test('masked/collector shells, nonzero exits and changed source never establish required success',()=>{
 for(const query of ['npm run test:a || true','npm run test:a; echo done','for c in a; do npm run test:a; done','cd elsewhere && npm run test:a'])assert.equal(requiredEvidence([{tool:'run_commands',toolCallId:'x',output:[{query,success:true}]}],epochs('x'),'final',checks,root)[0].passedOnFinalSource,false);
 assert.equal(requiredEvidence([{tool:'run_task',toolCallId:'x',output:{status:'ok',data:{command:'npm run test:a',exitCode:1}}}],epochs('x'),'final',checks,root)[0].passedOnFinalSource,false);
 assert.equal(requiredEvidence([{tool:'run_commands',toolCallId:'x',output:[{query:'npm run test:a',success:true}]}],epochs('x').map((e,i)=>i?e:{...e,epoch:{sha256:'old'}}),'final',checks,root)[0].passedOnFinalSource,false);
});
test('asynchronous inspections retain launch provenance and reject intervening edits',()=>{
 const tools=[{tool:'run_task',toolCallId:'launch',input:{kind:'project',task:'test:a'},output:{status:'ok',data:{run:'r1',state:'running'}}},
 {tool:'run_task',toolCallId:'poll',input:{kind:'inspect',run:'r1'},output:{status:'ok',data:{run:'r1',command:'npm run test:a',completed:{status:'ok',data:{command:'npm run test:a',exitCode:0}}}}}];
 const all=[...epochs('launch'),...epochs('poll')];assert.equal(requiredEvidence(tools,all,'final',checks,root)[0].passedOnFinalSource,true);
 assert.equal(requiredEvidence(tools,all.map(e=>e.callId==='launch'?{...e,epoch:{sha256:'old'}}:e),'final',checks,root)[0].passedOnFinalSource,false);
});
